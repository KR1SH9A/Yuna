/** Admit bounded Discord requests and atomically accept current generation results for delivery. */
import { ReplyPolicy } from './reply.policy.js';
import { prepareChatContext } from '../../ai/contracts/chat-context.js';
import { IntakeEvent } from '../../platform/intake/entities/intake-event.entity.js';
import type { ConversationAdmission, ChannelReplySettingsDto, ChannelReplySettingsUpdate, CommunityOperationalStatus } from './dto/conversation.dto.js';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { ConversationRequest } from './entities/conversation-request.entity.js';
import { ChannelReplySettings } from './entities/channel-reply-settings.entity.js';
import { ReplyDelivery } from './entities/reply-delivery.entity.js';
import { KnowledgeService } from './knowledge.service.js';
import type { AudienceBinding } from './entities/community-values.js';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import { IntakeService } from '../../platform/intake/intake.service.js';
import { TaskService } from '../../platform/jobs/task.service.js';
import type { MessageReference, NormalizedConversationMessage } from '../../discord/contracts.js';
import { noLatencyReporter, reportLatency, type LatencyReporter, type LatencySample } from '../../platform/runtime/latency.js';
import { assertDiscordId, invariant } from '../../platform/db/entity-values.js';

/** Text-only Community workflow. External reads/sends happen outside these short transactions. */
export class ConversationService {
  private knowledge: KnowledgeService | undefined;
  /** Compose the durable conversation owner; optional knowledge is attached once before ingress starts. */
  constructor(
    private readonly orm: MikroORM, readonly scope: InstallationScope, private readonly model: string,
    private readonly administration: GuildLifecycleService, private readonly intake: IntakeService,
    private readonly tasks: TaskService,
    private readonly latency: LatencyReporter = noLatencyReporter,
  ) {}

  /** Wire the same-installation knowledge owner once, resolving its pending-use invalidation callback without a framework. */
  setKnowledgeService(knowledge: KnowledgeService): void {
    invariant(!this.knowledge && knowledge.scope.installationId === this.scope.installationId && knowledge.scope.guildId === this.scope.guildId,
      'Knowledge service must be configured once for this installation');
    this.knowledge = knowledge;
  }

  /** Inspect one authorized channel without creating a settings row; revision zero describes the implicit default. */
  async readChannelSettings(em: EntityManager, channelId: string): Promise<ChannelReplySettingsDto> {
    invariant(em.isInTransaction(), 'Channel settings require the caller transaction');
    assertDiscordId(channelId);
    const settings = await em.findOne(ChannelReplySettings, { ...this.scope, channelId });
    return { channelId, mode: settings?.mode ?? 'direct', rowRevision: settings?.rowRevision ?? 0 };
  }

  /** Join an authorized installation transaction, revise one channel and cancel its obsolete pending work. */
  async updateChannelSettings(em: EntityManager, input: ChannelReplySettingsUpdate, at: Date): Promise<{ channelId: string; mode: 'silent' | 'direct'; rowRevision: number }> {
    invariant(em.isInTransaction(), 'Channel settings require the caller transaction');
    assertDiscordId(input.channelId);
    invariant(input.mode === 'silent' || input.mode === 'direct', 'Unsupported reply mode');
    let settings = await em.findOne(ChannelReplySettings, { ...this.scope, channelId: input.channelId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (settings) {
      invariant(input.expectedRowRevision !== null, 'Existing channel requires its current revision');
      settings.changeMode(input.mode, input.expectedRowRevision, at);
    } else {
      invariant(input.expectedRowRevision === null, 'Channel settings revision does not exist');
      settings = new ChannelReplySettings({ ...this.scope, createdAt: at, channelId: input.channelId, mode: input.mode,
        approvedKnowledgeScope: { schemaVersion: 1, entryIds: [] }, limits: { schemaVersion: 1, maxContextMessages: 8, maxContextCharacters: 6000, deadlineSeconds: 120 } });
      em.persist(settings);
    }
    await this.invalidatePending(em, 'channel_settings_changed', at, input.channelId);
    return { channelId: input.channelId, mode: input.mode, rowRevision: settings.rowRevision };
  }

  /** Return aggregate operational state only; message text and provider payloads never enter operator status. */
  async readOperationalStatus(em: EntityManager): Promise<CommunityOperationalStatus> {
    const pendingRequests = await em.count(ConversationRequest, { ...this.scope, stage: 'generating', canceledAt: null, deadline: { $gt: new Date() } });
    const readyDeliveries = await em.count(ReplyDelivery, { ...this.scope, state: 'READY' });
    const unknownDeliveries = await em.count(ReplyDelivery, { ...this.scope, state: 'UNKNOWN' });
    return { pendingRequests, readyDeliveries, unknownDeliveries };
  }

  /** Admit one durable request per original message, with a fixed deadline and bounded context. */
  async receiveInput(input: NormalizedConversationMessage): Promise<ConversationAdmission> {
    const started = performance.now();
    const now = new Date();
    const deadline = new Date(Math.min(input.createdAt.getTime(), now.getTime()) + 120_000);
    if (!ReplyPolicy.shouldConsiderReply(input, this.scope.guildId, 'direct', now)) return 'ignored';
    const context = input.chatContext ? prepareChatContext(input.chatContext) : undefined;
    invariant(!context || (context.guildId === input.guildId && context.channelId === input.channelId && context.sourceMessageId === input.messageId), 'Context belongs to another source');
    const result = await this.orm.em.fork().transactional(async em => {
      const admission = await this.administration.lockAdmission(em, this.scope);
      if (!admission) return 'ignored';
      const pending = await em.count(ConversationRequest, { ...this.scope, stage: 'generating', deadline: { $gt: now } });
      if (pending >= 20) return 'busy';
      let settings = await em.findOne(ChannelReplySettings, { ...this.scope, channelId: input.channelId });
      if (!settings) {
        settings = new ChannelReplySettings({ ...this.scope, createdAt: now, channelId: input.channelId, mode: 'direct', approvedKnowledgeScope: { schemaVersion: 1, entryIds: [] }, limits: { schemaVersion: 1, maxContextMessages: 8, maxContextCharacters: 6000, deadlineSeconds: 120 } });
        em.persist(settings);
      }
      if (!ReplyPolicy.shouldConsiderReply(input, this.scope.guildId, settings.mode, now)) return 'ignored';
      const policy = await this.administration.readPolicyConfig(em, this.scope);
      const purgeAfter = new Date(now.getTime() + policy.retention.payloadDays * 86400_000);
      const metadataPurgeAfter = new Date(now.getTime() + policy.retention.metadataDays * 86400_000);
      const observation = await this.intake.receiveInput(em, this.scope, input, now, deadline, purgeAfter, metadataPurgeAfter);
      if (!observation) return 'duplicate';
      // Honor channel limits without cutting an individual message or claiming a complete directory.
      const selectedContext = context ? { ...context, messages: context.messages.slice(-Math.min(8, settings.limits.maxContextMessages)),
        publicChannels: [...context.publicChannels] } : undefined;
      if (selectedContext && settings.limits.maxContextMessages === 0) selectedContext.messages = [];
      const contextBudget = Math.min(6000, settings.limits.maxContextCharacters) - input.text.length - (input.previousReply?.length ?? 0);
      if (selectedContext) {
        while (JSON.stringify(selectedContext).length > contextBudget && selectedContext.messages.length) selectedContext.messages = selectedContext.messages.slice(1);
        while (JSON.stringify(selectedContext).length > contextBudget && selectedContext.publicChannels.length) {
          selectedContext.publicChannels.pop(); selectedContext.directoryPartial = true;
        }
      }
      const chat = selectedContext && JSON.stringify(selectedContext).length <= contextBudget
        ? await this.intake.bindChatContext(em, this.scope, selectedContext, now, { purgeAfter, metadataPurgeAfter }) : undefined;
      const audience: AudienceBinding = { schemaVersion: 1, visibility: 'channel', channelId: input.channelId, requesterUserId: input.authorId, revision: 1 };
      const visible = await this.knowledge?.findVisibleEntries(em, { search: input.text, entryIds: settings.approvedKnowledgeScope.entryIds }, audience, new Date()) ?? [];
      // Keep the same total bound; current chat and approved knowledge share the remaining capacity.
      let remaining = Math.min(6_000, settings.limits.maxContextCharacters) - input.text.length - (input.previousReply?.length ?? 0)
        - (chat ? JSON.stringify(chat.context).length : 0);
      const selected = visible.filter(entry => {
        if (!entry.content || entry.content.length > remaining) return false;
        remaining -= entry.content.length; return true;
      });
      const request = new ConversationRequest({ ...this.scope, createdAt: now, requestKey: `message:${input.channelId}:${input.messageId}`,
        source: { kind: 'message', channelId: input.channelId, messageId: input.messageId }, sourceVersion: observation.revision,
        settingsRevision: settings.rowRevision, contextBindings: [{ owner: 'intake', recordId: observation.eventId, revision: observation.revision, contentHash: input.sourceHash },
          ...(chat?.bindings ?? []),
          ...selected.map(entry => ({ owner: 'knowledge' as const, recordId: entry.entryId, revision: entry.rowRevision, contentHash: entry.contentHash }))],
        audienceBinding: audience, deadline, purgeAfter });
      const taskId = this.tasks.registerTask(em, { ...this.scope, requestId: request.id,
        input: { text: input.text, ...(input.previousReply ? { previousReply: input.previousReply } : {}), maxOutputTokens: 512,
          ...(chat ? { chatContext: chat.context } : {}),
          ...(selected.length ? { approvedKnowledge: selected.map(entry => ({ entryId: entry.entryId, content: entry.content!, contentHash: entry.contentHash, revision: entry.rowRevision })) } : {}) },
        ...(selected.length ? { knowledgeChannelId: input.channelId } : {}),
        sourceEventId: observation.eventId, sourceRevision: observation.revision, safetyRevision: admission.safetyRevision,
        deadline, purgeAfter, model: this.model, now });
      request.expectTask(taskId, 'generating', request.rowRevision, now);
      observation.receipt.complete(observation.receipt.claimGeneration, 'handled', request.id, now);
      em.persist(request);
      return { requestId: request.id, taskId };
    });
    if (typeof result === 'string') return result;
    reportLatency(this.latency, { ...result, stage: 'admission_commit', durationMs: performance.now() - started, outcome: 'admitted' });
    return 'admitted';
  }

  /** Edit/delete prevents future disclosure and sends; it never automatically generates again. */
  async cancelRequest(reference: MessageReference): Promise<void> {
    if (reference.guildId !== this.scope.guildId) return;
    await this.orm.em.fork().transactional(async em => {
      await this.administration.lockAdmission(em, this.scope);
      const now = new Date();
      const eventId = await this.intake.invalidate(em, this.scope, reference, now);
      if (eventId) await this.tasks.invalidateSource(em, this.scope, eventId, now);
      const context = await em.findOne(IntakeEvent, { ...this.scope, sourceKey: `context:${reference.channelId}:${reference.messageId}` });
      if (context) {
        const dependent = await em.find(ConversationRequest, { ...this.scope, sourceChannelId: reference.channelId,
          stage: { $in: ['generating', 'accepted'] }, canceledAt: null, deadline: { $gt: now } });
        for (const request of dependent) {
          if (!request.contextBindings?.some(binding => binding.owner === 'intake' && binding.recordId === context.id)) continue;
          const primary = request.contextBindings.find(binding => binding.owner === 'intake');
          if (primary) await this.tasks.invalidateSource(em, this.scope, primary.recordId, now);
          request.cancel('context_changed', request.rowRevision, now);
          const reply = await em.findOne(ReplyDelivery, { ...this.scope, requestId: request.id, state: 'READY' });
          if (reply) reply.cancelBeforeDispatch('context_changed', reply.rowRevision, now);
        }
      }
      const request = await em.findOne(ConversationRequest, { ...this.scope, sourceChannelId: reference.channelId, sourceMessageId: reference.messageId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!request) return;
      request.cancel('source_changed', request.rowRevision, now);
      const delivery = await em.findOne(ReplyDelivery, { ...this.scope, requestId: request.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (delivery?.state === 'READY') delivery.cancelBeforeDispatch('source_changed', delivery.rowRevision, now);
    });
  }

  /** Copy valid terminal output into owner storage and acknowledge acceptance atomically. */
  async acceptReplyResults(): Promise<number> {
    const started = performance.now();
    const result = await this.orm.em.fork().transactional(async em => {
      const admission = await this.administration.lockAdmission(em, this.scope, 'continuation');
      const completions = await this.tasks.pendingResults(em, this.scope, 20);
      let accepted = 0;
      const samples: LatencySample[] = [];
      for (const completion of completions) {
        const now = new Date();
        const source = await this.intake.current(em, this.scope, completion.sourceEventId, completion.sourceRevision);
        const request = await em.findOne(ConversationRequest, { ...this.scope, id: completion.requestId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        const settings = request ? await em.findOne(ChannelReplySettings, { ...this.scope, channelId: request.sourceChannelId }) : null;
        const text = completion.payload?.text;
        const knowledgeCurrent = !request?.contextBindings?.some(binding => binding.owner === 'knowledge')
          || Boolean(this.knowledge && await this.knowledge.validateBindings(em, request.contextBindings, request.audienceBinding, now));
        const contextCurrent = request && await this.intake.validateContextBindings(em, this.scope, request.contextBindings);
        const valid = admission && admission.safetyRevision === completion.safetyRevision && source && request && settings?.mode === 'direct' && settings.rowRevision === request.settingsRevision
          && request.stage === 'generating' && request.expectedTaskId === completion.taskId && !request.canceledAt && request.deadline > now && !request.payloadPurgedAt
          && contextCurrent && knowledgeCurrent && ReplyPolicy.validateAudience(request.audienceBinding, request.sourceChannelId)
          && completion.outcome === 'success' && ReplyPolicy.validateReply(text);
        if (valid && request) {
          request.acceptReply({ taskId: completion.taskId, resultId: completion.resultId, sourceVersion: completion.sourceRevision, cancellationGeneration: request.cancellationGeneration, expectedRowRevision: request.rowRevision, at: now });
          em.persist(new ReplyDelivery({ ...this.scope, createdAt: now, requestId: request.id, acceptedResultReference: completion.resultId, acceptedContent: text!, supportingReferences: request.contextBindings ?? [],
            allowedMentions: { users: [], roles: [], everyone: false, repliedUser: false },
            destination: { transport: 'channel_message', channelId: request.sourceChannelId, replyMessageId: request.sourceMessageId, nonce: request.sourceMessageId!, enforceNonce: true },
            sourceVersion: request.sourceVersion, privacyRevision: 0, audienceBinding: request.audienceBinding, deadline: request.deadline, purgeAfter: request.purgeAfter, maxAttempts: 1 }));
          accepted++;
        } else if (request && request.stage === 'generating') request.cancel('generation_unavailable', request.rowRevision, now);
        await this.tasks.acknowledge(em, this.scope, completion, valid ? 'accepted' : 'discarded', valid ? 'reply_accepted' : 'obsolete_or_failed', now);
        const correlation = { taskId: completion.taskId, requestId: completion.requestId,
          outcome: valid ? 'accepted' as const : 'discarded' as const };
        samples.push({ ...correlation, stage: 'completion_wait', durationMs: now.getTime() - new Date(completion.resultCreatedAt).getTime() });
        if (completion.queueWaitMs !== null) samples.push({ ...correlation, stage: 'queue_wait', durationMs: completion.queueWaitMs });
      }
      return { accepted, samples };
    });
    // All samples wait for the batch commit; rollback must never look like accepted work.
    const durationMs = performance.now() - started;
    for (const sample of result.samples) {
      reportLatency(this.latency, sample);
      if (sample.stage === 'completion_wait') reportLatency(this.latency, { ...sample, stage: 'acceptance_commit', durationMs });
    }
    return result.accepted;
  }

  /** A gateway gap makes prior source observations unreliable; never replay pending replies. */
  async cancelPending(): Promise<void> {
    await this.orm.em.fork().transactional(async em => {
      await this.administration.lockAdmission(em, this.scope);
      await this.invalidatePending(em, 'gateway_gap', new Date());
    });
  }

  /** Join a locked Administration change; cancel future work while preserving already-started effects. */
  async invalidatePending(em: EntityManager, reason: string, now: Date, channelId?: string): Promise<void> {
    if (!em.isInTransaction()) throw new Error('Community invalidation requires the caller transaction');
    const requests = await em.find(ConversationRequest, { ...this.scope, stage: { $in: ['generating', 'accepted'] },
      deadline: { $gt: now }, canceledAt: null, ...(channelId ? { sourceChannelId: channelId } : {}) }, { orderBy: { id: 'asc' } });
    for (const request of requests) {
      const delivery = await em.findOne(ReplyDelivery, { ...this.scope, requestId: request.id });
      if (delivery && delivery.state !== 'READY') continue;
      const source = request.contextBindings?.find(binding => binding.owner === 'intake');
      if (source) await this.tasks.invalidateSource(em, this.scope, source.recordId, now);
      request.cancel(reason, request.rowRevision, now);
      if (delivery) delivery.cancelBeforeDispatch(reason, delivery.rowRevision, now);
    }
  }

  /** Invalidate only pending workflows that copied the changed knowledge, preserving already started external sends. */
  async invalidateKnowledge(em: EntityManager, entryIds: readonly string[], reason: string, now: Date): Promise<void> {
    invariant(em.isInTransaction(), 'Knowledge invalidation requires the caller transaction');
    const selected = new Set(entryIds);
    const requests = await em.find(ConversationRequest, { ...this.scope, stage: { $in: ['generating', 'accepted'] },
      canceledAt: null, deadline: { $gt: now } }, { orderBy: { id: 'asc' } });
    for (const request of requests) {
      if (!request.contextBindings?.some(binding => binding.owner === 'knowledge' && selected.has(binding.recordId))) continue;
      const delivery = await em.findOne(ReplyDelivery, { ...this.scope, requestId: request.id });
      if (delivery && delivery.state !== 'READY') continue;
      const source = request.contextBindings.find(binding => binding.owner === 'intake');
      if (source) await this.tasks.invalidateSource(em, this.scope, source.recordId, now);
      request.cancel(reason, request.rowRevision, now);
      if (delivery) delivery.cancelBeforeDispatch(reason, delivery.rowRevision, now);
    }
  }

  /** Bounded maintenance keeps erasing expired data during pause/removal and never extends reply deadlines. */
  async runRetention(): Promise<void> {
    await this.orm.em.fork().transactional(async em => {
      await this.administration.lockPrivacy(em, this.scope);
      const now = new Date();
      const expired = await em.find(ConversationRequest, { ...this.scope, stage: 'generating', deadline: { $lte: now } }, { limit: 50 });
      for (const row of expired) row.cancel('deadline', row.rowRevision, now);
      const requests = await em.find(ConversationRequest, { ...this.scope, payloadPurgedAt: null, purgeAfter: { $lte: now } }, { limit: 50 });
      for (const row of requests) row.purgePayload('retention', row.rowRevision, now);
      const deliveries = await em.find(ReplyDelivery, { ...this.scope, payloadPurgedAt: null, purgeAfter: { $lte: now } }, { limit: 50 });
      for (const row of deliveries) row.purgePayload('retention', row.rowRevision, now);
      await this.intake.purgeExpired(em, this.scope, now);
      await this.tasks.purgeExpired(em, this.scope, now);
      await this.knowledge?.purgeExpired(em, now);
      await em.flush();
      const policy = await this.administration.readPolicyConfig(em, this.scope);
      await this.purgeMetadata(em, now, policy.retention.metadataDays);
      await this.intake.purgeMetadata(em, this.scope, now);
    });
  }

  /** Delete only expired, erased and resolved reply graphs; uncertain external effects remain available for reconciliation. */
  async purgeMetadata(em: EntityManager, now: Date, metadataDays: number): Promise<number> {
    invariant(em.isInTransaction(), 'Community metadata cleanup requires the caller transaction');
    invariant(Number.isInteger(metadataDays) && metadataDays >= 1 && metadataDays <= 3650, 'Invalid metadata retention');
    const cutoff = new Date(now.getTime() - metadataDays * 86400_000);
    const requests = await em.find(ConversationRequest, { ...this.scope, payloadPurgedAt: { $ne: null }, createdAt: { $lte: cutoff },
      stage: { $in: ['accepted', 'declined', 'canceled'] } }, { limit: 50, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    let removed = 0;
    for (const request of requests) {
      const delivery = await em.findOne(ReplyDelivery, { ...this.scope, requestId: request.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (delivery && (!delivery.payloadPurgedAt || ['READY', 'DISPATCHED', 'UNKNOWN'].includes(delivery.state))) continue;
      if (!await this.tasks.purgeWorkflowMetadata(em, this.scope, request.id, cutoff, now)) continue;
      await em.execute('delete from reply_delivery where installation_id=? and guild_id=? and request_id=?', [this.scope.installationId, this.scope.guildId, request.id]);
      await em.execute('delete from conversation_request where installation_id=? and guild_id=? and id=?', [this.scope.installationId, this.scope.guildId, request.id]);
      removed++;
    }
    return removed;
  }

  /** Removal erases copied text in bounded batches and preserves delivery fingerprints for uncertain effects. */
  async cleanupForRemoval(em: EntityManager, now: Date): Promise<{ disposition: 'pending' | 'retained' | 'complete'; reasonCode: string | null }> {
    invariant(em.isInTransaction(), 'Community cleanup requires the caller transaction');
    await this.invalidatePending(em, 'installation_removal', now);
    const knowledgeCleanup = await this.knowledge?.cleanupForRemoval(em, now);
    const requests = await em.find(ConversationRequest, { ...this.scope, payloadPurgedAt: null }, { limit: 50, orderBy: { id: 'asc' } });
    for (const request of requests) request.purgePayload('installation_removal', request.rowRevision, now);
    const deliveries = await em.find(ReplyDelivery, { ...this.scope, payloadPurgedAt: null }, { limit: 50, orderBy: { id: 'asc' } });
    for (const delivery of deliveries) delivery.purgePayload('installation_removal', delivery.rowRevision, now);
    await em.flush();
    if (knowledgeCleanup?.disposition === 'pending' || await em.count(ConversationRequest, { ...this.scope, payloadPurgedAt: null })
      || await em.count(ReplyDelivery, { ...this.scope, payloadPurgedAt: null })) return { disposition: 'pending', reasonCode: 'payload_cleanup' };
    const remaining = await em.count(ConversationRequest, this.scope);
    return remaining || knowledgeCleanup?.disposition === 'retained' ? { disposition: 'retained', reasonCode: 'delivery_and_replay_metadata' } : { disposition: 'complete', reasonCode: null };
  }
}
