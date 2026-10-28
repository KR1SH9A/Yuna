/** Deliver accepted replies once, then reconcile uncertain outcomes on a separate maintenance path. */
import { ReplyPolicy } from './reply.policy.js';
import { createHash } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ReplyDelivery } from './entities/reply-delivery.entity.js';
import { ConversationRequest } from './entities/conversation-request.entity.js';
import { ChannelReplySettings } from './entities/channel-reply-settings.entity.js';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import { IntakeService } from '../../platform/intake/intake.service.js';
import { TaskService } from '../../platform/jobs/task.service.js';
import type { DiscordGateway } from '../../discord/discord.module.js';
import type { DiscordSendResult } from '../../discord/contracts.js';
import { noLatencyReporter, reportLatency, type LatencyReporter } from '../../platform/runtime/latency.js';
import { KnowledgeService } from './knowledge.service.js';
import { invariant } from '../../platform/db/entity-values.js';

/** Owner-controlled intent/claim/outcome; no transaction stays open during Discord I/O. */
export class ReplyDeliveryService {
  private knowledge: KnowledgeService | undefined;
  private reconciliationCursor: string | undefined;
  // One bot owns this pilot: maintenance must not fence its own still-running send.
  private readonly activeDispatches = new Set<string>();
  /** Compose owner services and a narrow Discord transport; no external work runs during construction. */
  constructor(private readonly orm: MikroORM, private readonly scope: InstallationScope,
    private readonly administration: GuildLifecycleService, private readonly intake: IntakeService,
    private readonly transport: Pick<DiscordGateway, 'readSource' | 'sendReply' | 'findReply'>,
    private readonly tasks: TaskService = new TaskService(),
    private readonly latency: LatencyReporter = noLatencyReporter) {}

  /** Attach the same knowledge owner used at preparation so later sends cannot publish retired context. */
  setKnowledgeService(knowledge: KnowledgeService): void {
    invariant(!this.knowledge && knowledge.scope.installationId === this.scope.installationId && knowledge.scope.guildId === this.scope.guildId,
      'Knowledge service must be configured once for this installation');
    this.knowledge = knowledge;
  }

  /** Scan durable intents; unknown sends are only reconciled, never automatically retried. */
  async recoverDueDeliveries(signal: AbortSignal): Promise<void> {
    await this.dispatchReadyDeliveries(signal);
    if (!signal.aborted) await this.reconcileDueDeliveries(signal);
  }

  /** New replies have their own fast loop, independent of slow searches for uncertain sends. */
  async dispatchReadyDeliveries(signal: AbortSignal): Promise<void> {
    const ready = await this.orm.em.fork().find(ReplyDelivery, { ...this.scope, state: 'READY' }, { limit: 20, orderBy: { createdAt: 'asc' } });
    for (const row of ready) {
      if (signal.aborted) return;
      await this.dispatch(row.id, signal);
    }
  }

  /** Rotate uncertain intents without sending them again; run separately as maintenance. */
  async reconcileDueDeliveries(signal: AbortSignal): Promise<void> {
    // Rotate uncertain intents independently so old unknown sends cannot starve new replies.
    const uncertain = await this.orm.em.fork().find(ReplyDelivery, { ...this.scope,
      state: { $in: ['DISPATCHED', 'UNKNOWN'] }, purgeAfter: { $gt: new Date() },
      ...(this.reconciliationCursor ? { id: { $gt: this.reconciliationCursor } } : {}),
    }, { limit: 5, orderBy: { id: 'asc' } });
    this.reconciliationCursor = uncertain.length === 5 ? uncertain.at(-1)!.id : undefined;
    for (const row of uncertain) {
      if (signal.aborted) return;
      await this.reconcile(row.id, signal);
    }
  }

  /** Fetch current source and permissions, then claim exactly one attempt against locked state. */
  async dispatch(id: string, signal: AbortSignal): Promise<void> {
    if (this.activeDispatches.has(id)) return;
    this.activeDispatches.add(id);
    try {
      const initial = await this.orm.em.fork().findOne(ReplyDelivery, { ...this.scope, id, state: 'READY' });
      if (!initial?.channelId || !initial.replyMessageId) return;
      const remote = await this.transport.readSource({ guildId: this.scope.guildId, channelId: initial.channelId, messageId: initial.replyMessageId }, signal);
      if (signal.aborted) return;
      const claim = await this.orm.em.fork().transactional(async em => {
        const admission = await this.administration.lockAdmission(em, this.scope, 'continuation');
        const request = await em.findOne(ConversationRequest, { ...this.scope, id: initial.requestId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        const binding = request?.contextBindings?.find(value => value.owner === 'intake');
        const source = binding ? await this.intake.current(em, this.scope, binding.recordId, binding.revision) : null;
        const row = await em.findOne(ReplyDelivery, { ...this.scope, id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!row || row.state !== 'READY') return null;
        const now = new Date();
        if (row.deadline <= now) { row.expire(row.rowRevision, now); return null; }
        const settings = await em.findOne(ChannelReplySettings, { ...this.scope, channelId: row.channelId! });
        const resultCurrent = admission && await this.tasks.isResultCurrent(em, this.scope, row.acceptedResultReference, admission.safetyRevision);
        const knowledgeCurrent = !request?.contextBindings?.some(binding => binding.owner === 'knowledge')
          || Boolean(this.knowledge && await this.knowledge.validateBindings(em, request.contextBindings, request.audienceBinding, now));
        if (!admission || !resultCurrent || !request || request.acceptedResultReference !== row.acceptedResultReference
          || !ReplyPolicy.validateAudience(row.audienceBinding, row.channelId!, request.audienceBinding)
          || row.channelId !== request.sourceChannelId || row.replyMessageId !== request.sourceMessageId
          || !knowledgeCurrent || request.canceledAt || request.stage !== 'accepted' || !source || !remote.exists || !remote.canSend || source.hash !== remote.sourceHash || !ReplyPolicy.validateReply(row.acceptedContent, row.allowedMentions) || settings?.mode !== 'direct' || settings.rowRevision !== request.settingsRevision) {
          row.cancelBeforeDispatch('source_or_permission_changed', row.rowRevision, now);
          return null;
        }
        const fingerprint = createHash('sha256').update(JSON.stringify({ channel: row.channelId, reply: row.replyMessageId, nonce: row.nonce, contentHash: row.contentHash })).digest('hex');
        const generation = row.claimDispatch({ expectedGeneration: row.generation, expectedRowRevision: row.rowRevision, sourceVersion: request.sourceVersion,
          privacyRevision: 0, audienceRevision: request.audienceBinding.revision, executorId: 'bot-delivery', requestFingerprint: fingerprint, at: now });
        // This durable flag precedes I/O; a crash here remains an ambiguous opportunity, never a retry.
        row.markSent(generation, row.rowRevision, now);
        return { generation, requestId: request.id, requestCreatedAt: request.createdAt,
          payload: { guildId: this.scope.guildId, channelId: row.channelId!, messageId: row.replyMessageId!, content: row.acceptedContent, nonce: row.nonce!, deadline: row.deadline, expectedSourceHash: source.hash } };
      });
      if (!claim) return;
      const started = performance.now();
      let outcome: DiscordSendResult;
      try { outcome = await this.transport.sendReply(claim.payload, signal); }
      catch { outcome = { classification: 'unknown', code: 'transport_failure' }; }
      const durationMs = performance.now() - started;
      const respondedAt = Date.now();
      const recorded = await this.orm.em.fork().transactional(async em => {
        await this.administration.lockAdmission(em, this.scope, 'continuation');
        const row = await em.findOne(ReplyDelivery, { ...this.scope, id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (row?.state !== 'DISPATCHED' || row.generation !== claim.generation) return false;
        row.recordOutcome(claim.generation, outcome, row.rowRevision, new Date());
        return true;
      });
      if (!recorded) return;
      reportLatency(this.latency, { requestId: claim.requestId, stage: 'discord_delivery', durationMs, outcome: outcome.classification });
      if (outcome.classification === 'delivered') reportLatency(this.latency, { requestId: claim.requestId,
        stage: 'end_to_end', durationMs: respondedAt - claim.requestCreatedAt.getTime(), outcome: 'delivered' });
    } finally {
      // Every return and failure releases local ownership so later recovery can reconcile.
      this.activeDispatches.delete(id);
    }
  }

  /** Positive attributable evidence can resolve uncertainty; an empty search is not no-send proof. */
  async reconcile(id: string, signal: AbortSignal): Promise<void> {
    if (this.activeDispatches.has(id)) return;
    const candidate = await this.orm.em.fork().transactional(async em => {
      await this.administration.lockAdmission(em, this.scope, 'continuation');
      const row = await em.findOne(ReplyDelivery, { ...this.scope, id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      // Recheck after awaited locks/reads in case dispatch began while maintenance waited.
      if (this.activeDispatches.has(id) || !row?.attempt || !row.channelId || !row.replyMessageId || !row.nonce) return null;
      if (row.state === 'DISPATCHED') {
        if (new Date(row.attempt.claimedAt).getTime() + 30_000 > Date.now()) return null;
        row.recordOutcome(row.generation, { classification: 'unknown', code: 'interrupted_delivery' }, row.rowRevision, new Date());
      }
      if (row.state !== 'UNKNOWN' || row.purgeAfter <= new Date()) return null;
      return { guildId: this.scope.guildId, channelId: row.channelId, messageId: row.replyMessageId, nonce: row.nonce, contentHash: row.contentHash, generation: row.generation };
    });
    if (!candidate || signal.aborted) return;
    const messageId = await this.transport.findReply(candidate, signal);
    if (!messageId) return;
    await this.orm.em.fork().transactional(async em => {
      await this.administration.lockAdmission(em, this.scope, 'continuation');
      const row = await em.findOne(ReplyDelivery, { ...this.scope, id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (row?.state === 'UNKNOWN' && row.generation === candidate.generation) row.recordReconciliation(row.generation, { classification: 'delivered', messageId }, `discord-message:${messageId}`, row.rowRevision, new Date());
    });
  }
}
