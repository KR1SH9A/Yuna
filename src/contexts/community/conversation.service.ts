import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { ConversationRequest } from './entities/conversation-request.entity.js';
import { ChannelReplySettings } from './entities/channel-reply-settings.entity.js';
import { ReplyDelivery } from './entities/reply-delivery.entity.js';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import { IntakeService } from '../../platform/intake/intake.service.js';
import { TaskService } from '../../platform/jobs/task.service.js';
import type { MessageReference, NormalizedConversationMessage } from '../../discord/contracts.js';

/** Text-only Community workflow. External reads/sends happen outside these short transactions. */
export class ConversationService {
  constructor(
    private readonly orm: MikroORM, readonly scope: InstallationScope, private readonly model: string,
    private readonly administration: GuildLifecycleService, private readonly intake: IntakeService,
    private readonly tasks: TaskService,
  ) {}

  /** Admit one durable request per original message, with a fixed deadline and bounded context. */
  async receiveInput(input: NormalizedConversationMessage): Promise<'admitted' | 'duplicate' | 'ignored' | 'busy'> {
    const now = new Date();
    const deadline = new Date(Math.min(input.createdAt.getTime(), now.getTime()) + 120_000);
    if (input.guildId !== this.scope.guildId || !input.text.trim() || input.text.length > 4000 || (input.previousReply?.length ?? 0) > 2000 || deadline <= now || input.createdAt.getTime() > now.getTime() + 30_000) return 'ignored';
    return this.orm.em.fork().transactional(async em => {
      const admission = await this.administration.lockAdmission(em, this.scope);
      if (!admission) return 'ignored';
      const pending = await em.count(ConversationRequest, { ...this.scope, stage: 'generating', deadline: { $gt: now } });
      if (pending >= 20) return 'busy';
      let settings = await em.findOne(ChannelReplySettings, { ...this.scope, channelId: input.channelId });
      if (!settings) {
        settings = new ChannelReplySettings({ ...this.scope, createdAt: now, channelId: input.channelId, mode: 'direct', approvedKnowledgeScope: { schemaVersion: 1, entryIds: [] }, limits: { schemaVersion: 1, maxContextMessages: 1, maxContextCharacters: 6000, deadlineSeconds: 120 } });
        em.persist(settings);
      }
      if (settings.mode !== 'direct') return 'ignored';
      const purgeAfter = new Date(now.getTime() + 86400_000);
      const observation = await this.intake.receiveInput(em, this.scope, input, now, deadline, purgeAfter);
      if (!observation) return 'duplicate';
      const request = new ConversationRequest({ ...this.scope, createdAt: now, requestKey: `message:${input.channelId}:${input.messageId}`,
        source: { kind: 'message', channelId: input.channelId, messageId: input.messageId }, sourceVersion: observation.revision,
        settingsRevision: settings.rowRevision, contextBindings: [{ owner: 'intake', recordId: observation.eventId, revision: observation.revision, contentHash: input.sourceHash }],
        audienceBinding: { schemaVersion: 1, visibility: 'channel', channelId: input.channelId, requesterUserId: input.authorId, revision: 1 }, deadline, purgeAfter });
      const taskId = this.tasks.registerTask(em, { ...this.scope, requestId: request.id,
        input: { text: input.text, ...(input.previousReply ? { previousReply: input.previousReply } : {}), maxOutputTokens: 512 },
        sourceEventId: observation.eventId, sourceRevision: observation.revision, safetyRevision: admission.safetyRevision,
        deadline, purgeAfter, model: this.model, now });
      request.expectTask(taskId, 'generating', request.rowRevision, now);
      observation.receipt.complete(observation.receipt.claimGeneration, 'handled', request.id, now);
      em.persist(request);
      return 'admitted';
    });
  }

  /** Edit/delete prevents future disclosure and sends; it never automatically generates again. */
  async cancelRequest(reference: MessageReference): Promise<void> {
    if (reference.guildId !== this.scope.guildId) return;
    await this.orm.em.fork().transactional(async em => {
      await this.administration.lockAdmission(em, this.scope);
      const now = new Date();
      const eventId = await this.intake.invalidate(em, this.scope, reference, now);
      if (eventId) await this.tasks.invalidateSource(em, this.scope, eventId, now);
      const request = await em.findOne(ConversationRequest, { ...this.scope, sourceChannelId: reference.channelId, sourceMessageId: reference.messageId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!request) return;
      request.cancel('source_changed', request.rowRevision, now);
      const delivery = await em.findOne(ReplyDelivery, { ...this.scope, requestId: request.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (delivery?.state === 'READY') delivery.cancelBeforeDispatch('source_changed', delivery.rowRevision, now);
    });
  }

  /** Copy valid terminal output into owner storage and acknowledge acceptance atomically. */
  async acceptReplyResults(): Promise<number> {
    return this.orm.em.fork().transactional(async em => {
      const admission = await this.administration.lockAdmission(em, this.scope);
      const completions = await this.tasks.pendingResults(em, this.scope, 20);
      let accepted = 0;
      for (const completion of completions) {
        const now = new Date();
        const source = await this.intake.current(em, this.scope, completion.sourceEventId, completion.sourceRevision);
        const request = await em.findOne(ConversationRequest, { ...this.scope, id: completion.requestId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        const settings = request ? await em.findOne(ChannelReplySettings, { ...this.scope, channelId: request.sourceChannelId }) : null;
        const text = completion.payload?.text;
        const valid = admission && admission.safetyRevision === completion.safetyRevision && source && request && settings?.mode === 'direct' && settings.rowRevision === request.settingsRevision
          && request.stage === 'generating' && request.expectedTaskId === completion.taskId && !request.canceledAt && request.deadline > now && !request.payloadPurgedAt
          && completion.outcome === 'success' && typeof text === 'string' && text.trim().length > 0 && text.length <= 2000;
        if (valid && request) {
          request.acceptReply({ taskId: completion.taskId, resultId: completion.resultId, sourceVersion: completion.sourceRevision, cancellationGeneration: request.cancellationGeneration, expectedRowRevision: request.rowRevision, at: now });
          em.persist(new ReplyDelivery({ ...this.scope, createdAt: now, requestId: request.id, acceptedResultReference: completion.resultId, acceptedContent: text!, supportingReferences: request.contextBindings ?? [],
            allowedMentions: { users: [], roles: [], everyone: false, repliedUser: false },
            destination: { transport: 'channel_message', channelId: request.sourceChannelId, replyMessageId: request.sourceMessageId, nonce: request.sourceMessageId!, enforceNonce: true },
            sourceVersion: request.sourceVersion, privacyRevision: 0, audienceBinding: request.audienceBinding, deadline: request.deadline, purgeAfter: request.purgeAfter, maxAttempts: 1 }));
          accepted++;
        } else if (request && request.stage === 'generating') request.cancel('generation_unavailable', request.rowRevision, now);
        await this.tasks.acknowledge(em, this.scope, completion, valid ? 'accepted' : 'discarded', valid ? 'reply_accepted' : 'obsolete_or_failed', now);
      }
      return accepted;
    });
  }

  /** A gateway gap makes prior source observations unreliable; never replay pending replies. */
  async cancelPending(): Promise<void> {
    await this.orm.em.fork().transactional(async em => {
      await this.administration.lockAdmission(em, this.scope);
      const now = new Date();
      const requests = await em.find(ConversationRequest, { ...this.scope, stage: { $in: ['generating', 'accepted'] }, deadline: { $gt: now }, canceledAt: null });
      for (const request of requests) {
        const delivery = await em.findOne(ReplyDelivery, { ...this.scope, requestId: request.id });
        if (delivery && delivery.state !== 'READY') continue;
        request.cancel('gateway_gap', request.rowRevision, now);
        if (delivery) delivery.cancelBeforeDispatch('gateway_gap', delivery.rowRevision, now);
      }
    });
  }

  /** Bounded maintenance shares the installation gate and never extends reply deadlines. */
  async runRetention(): Promise<void> {
    await this.orm.em.fork().transactional(async em => {
      await this.administration.lockAdmission(em, this.scope);
      const now = new Date();
      const expired = await em.find(ConversationRequest, { ...this.scope, stage: 'generating', deadline: { $lte: now } }, { limit: 50 });
      for (const row of expired) row.cancel('deadline', row.rowRevision, now);
      const requests = await em.find(ConversationRequest, { ...this.scope, payloadPurgedAt: null, purgeAfter: { $lte: now } }, { limit: 50 });
      for (const row of requests) row.purgePayload('retention', row.rowRevision, now);
      const deliveries = await em.find(ReplyDelivery, { ...this.scope, payloadPurgedAt: null, purgeAfter: { $lte: now } }, { limit: 50 });
      for (const row of deliveries) row.purgePayload('retention', row.rowRevision, now);
      await this.intake.purgeExpired(em, this.scope, now);
      await this.tasks.purgeExpired(em, this.scope, now);
    });
  }
}
