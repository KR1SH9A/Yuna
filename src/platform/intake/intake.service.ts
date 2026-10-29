/** Durable owner receipts keep immutable originals separate from disposable current-source markers. */
import { createHash } from 'node:crypto';
import type { ChatContext } from '../../ai/contracts/chat-context.js';
import type { EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import { IntakeEvent } from './entities/intake-event.entity.js';
import { IntakeDelivery } from './entities/intake-delivery.entity.js';
import type { InstallationScope } from '../../contexts/administration/guild-lifecycle.service.js';
import type { NormalizedConversationMessage, MessageReference } from '../../discord/contracts.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, copyJson, invariant, type JsonObject } from '../db/entity-values.js';

export interface OriginalMessageProvenance extends MessageReference {
  eventKind: 'message_create';
  authorKind: 'user' | 'bot' | 'webhook' | 'system' | 'unknown';
  authorUserId: string | null;
  webhookId: string | null;
  messageType: number;
  createdAt: Date | null;
  observedAt: Date;
  gatewaySessionId?: string;
  shardId?: number;
  gatewaySequence?: number;
}
export interface OriginalMessageCapture {
  originalContent: string | null;
  attachments: readonly { id: string; filename: string; contentType: string | null; byteSize: number; description: string | null }[];
  contentAccess: 'available' | 'restricted' | 'missing';
  attachmentsComplete: boolean;
  missingReasons: readonly string[];
}
export interface IntakeRetention { purgeAfter: Date; metadataPurgeAfter: Date }
export interface OriginalIntake { event: IntakeEvent; receipt: IntakeDelivery; duplicate: boolean }

/** This namespace cannot collide with Community's current-source identity. */
function originalKey(reference: MessageReference): string { return `original:${reference.channelId}:${reference.messageId}`; }

/** Validate bounded transport facts before copying them; text is never normalized or reconstructed. */
export function validateOriginalCapture(provenance: OriginalMessageProvenance, capture: OriginalMessageCapture): void {
  for (const id of [provenance.guildId, provenance.channelId, provenance.messageId]) assertDiscordId(id);
  invariant(provenance.eventKind === 'message_create', 'Only original create events establish evidence');
  invariant(['user', 'bot', 'webhook', 'system', 'unknown'].includes(provenance.authorKind), 'Invalid original author kind');
  if (provenance.authorUserId !== null) assertDiscordId(provenance.authorUserId);
  invariant(['user', 'bot'].includes(provenance.authorKind) || provenance.authorUserId === null, 'Non-user event cannot establish a human author');
  if (provenance.webhookId !== null) assertDiscordId(provenance.webhookId);
  assertNonNegativeInteger(provenance.messageType, 'messageType');
  invariant(provenance.messageType <= 2_147_483_647, 'Message type exceeds storage range');
  invariant(provenance.gatewaySessionId === undefined || typeof provenance.gatewaySessionId === 'string'
    && /^[^\s\p{Cc}]{1,200}$/u.test(provenance.gatewaySessionId), 'Gateway session identity must be bounded');
  assertDate(provenance.observedAt, 'observedAt');
  if (provenance.createdAt !== null) assertDate(provenance.createdAt, 'createdAt');
  invariant(['available', 'restricted', 'missing'].includes(capture.contentAccess), 'Invalid original content access');
  invariant(capture.originalContent === null || typeof capture.originalContent === 'string' && capture.originalContent.length <= 100_000,
    'Original content must be bounded');
  invariant(capture.originalContent === null || capture.contentAccess === 'available', 'Unavailable content cannot become an original body');
  invariant(typeof capture.attachmentsComplete === 'boolean' && Array.isArray(capture.attachments) && capture.attachments.length <= 100, 'Invalid attachment coverage');
  const ids = new Set<string>();
  for (const attachment of capture.attachments) {
    assertDiscordId(attachment.id); assertNonNegativeInteger(attachment.byteSize, 'attachment.byteSize');
    invariant(!ids.has(attachment.id) && typeof attachment.filename === 'string' && attachment.filename.length <= 1024
      && (attachment.contentType === null || typeof attachment.contentType === 'string' && attachment.contentType.length <= 255)
      && (attachment.description === null || typeof attachment.description === 'string' && attachment.description.length <= 4096), 'Invalid original attachment');
    ids.add(attachment.id);
  }
  invariant(Array.isArray(capture.missingReasons) && capture.missingReasons.length <= 100
    && capture.missingReasons.every(reason => typeof reason === 'string' && /^[a-z0-9_.-]{1,120}$/.test(reason)), 'Capture reasons must be bounded codes');
  invariant(Buffer.byteLength(JSON.stringify(capture), 'utf8') <= 512 * 1024, 'Original capture exceeds storage boundary');
}

/** Platform intake owns immutable message observations and current-source validity. */
export class IntakeService {
  /** Caller holds installation/safety locks; first original wins even after a current-source tombstone. */
  async receiveOriginal(em: EntityManager, scope: InstallationScope, provenance: OriginalMessageProvenance,
    capture: OriginalMessageCapture, now: Date, retention: IntakeRetention): Promise<OriginalIntake> {
    validateOriginalCapture(provenance, capture);
    invariant(provenance.guildId === scope.guildId, 'Original belongs to another guild');
    const sourceKey = originalKey(provenance);
    const existing = await this.findOriginal(em, scope, provenance);
    if (existing) return { event: existing, receipt: await em.findOneOrFail(IntakeDelivery,
      { ...scope, eventId: existing.id, owner: 'moderation' }, { lockMode: LockMode.PESSIMISTIC_WRITE }), duplicate: true };
    const captured = copyJson(capture);
    const event = new IntakeEvent({ ...scope, createdAt: now, eventKind: 'message_create', sourceEventKey: `moderation:${sourceKey}`, sourceKey,
      ingressSequence: BigInt(now.getTime()), observedAt: provenance.observedAt,
      messageCreatedAt: provenance.createdAt ?? undefined, authorKind: provenance.authorKind, authorUserId: provenance.authorUserId ?? undefined,
      webhookId: provenance.webhookId ?? undefined, messageType: provenance.messageType, gatewaySessionId: provenance.gatewaySessionId,
      shardId: provenance.shardId, gatewaySequence: provenance.gatewaySequence,
      contentAccess: capture.contentAccess === 'missing' ? 'unknown' : capture.contentAccess,
      snapshot: { schemaVersion: 1, fields: { capture: captured as unknown as JsonObject } },
      contentHash: capture.originalContent === null ? undefined : createHash('sha256').update(capture.originalContent).digest('hex'),
      coverage: [...(capture.originalContent !== null ? ['original_body'] : []), ...(capture.attachmentsComplete ? ['attachment_descriptors'] : [])],
      originalAttachments: capture.attachments.map(item => ({ id: item.id, filename: item.filename, mediaType: item.contentType, byteSize: item.byteSize, artifactId: null })),
      ...retention });
    const receipt = this.moderationReceipt(scope, event.id, sourceKey, now);
    em.persist([event, receipt]);
    return { event, receipt, duplicate: false };
  }

  /** Only the authentic original namespace is resolvable; normalized/current REST snapshots are excluded. */
  async findOriginal(em: EntityManager, scope: InstallationScope, reference: MessageReference): Promise<IntakeEvent | null> {
    return em.findOne(IntakeEvent, { ...scope, eventKind: 'message_create', sourceEventKey: `moderation:${originalKey(reference)}` },
      { lockMode: LockMode.PESSIMISTIC_WRITE });
  }

  /** Reports retain allegation provenance separately; they never supply original content or a sanction target. */
  async receiveReport(em: EntityManager, scope: InstallationScope, input: MessageReference & { actorId: string; requestId: string; allegation: string },
    now: Date, retention: IntakeRetention): Promise<OriginalIntake> {
    for (const id of [input.actorId, input.channelId, input.messageId]) assertDiscordId(id);
    invariant(input.guildId === scope.guildId && /^[^\s\p{Cc}]{1,200}$/u.test(input.requestId), 'Invalid report provenance');
    invariant(typeof input.allegation === 'string' && input.allegation.length <= 4000, 'Report allegation must be bounded');
    const sourceEventKey = `moderation-report:${input.requestId}`;
    const existing = await em.findOne(IntakeEvent, { ...scope, sourceEventKey }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (existing) {
      invariant(existing.targetSourceKey === originalKey(input) && existing.requestActorId === input.actorId, 'Report request cannot change its original target');
      return { event: existing, receipt: await em.findOneOrFail(IntakeDelivery, { ...scope, eventId: existing.id, owner: 'moderation' },
        { lockMode: LockMode.PESSIMISTIC_WRITE }), duplicate: true };
    }
    const event = new IntakeEvent({ ...scope, createdAt: now, eventKind: 'report', sourceEventKey, targetSourceKey: originalKey(input),
      requestActorId: input.actorId, ingressSequence: BigInt(now.getTime()), observedAt: now, authorKind: 'user', authorUserId: input.actorId,
      contentAccess: 'available', coverage: ['report_allegation'], snapshot: { schemaVersion: 1, fields: { allegation: input.allegation } }, ...retention });
    const receipt = this.moderationReceipt(scope, event.id, originalKey(input), now);
    em.persist([event, receipt]);
    return { event, receipt, duplicate: false };
  }

  /** One local admission transaction owns the lease and completes its receipt with the owner case. */
  private moderationReceipt(scope: InstallationScope, eventId: string, orderKey: string, now: Date): IntakeDelivery {
    const receipt = new IntakeDelivery({ ...scope, createdAt: now, eventId, owner: 'moderation', orderKey });
    receipt.claim('moderation-admission', now, new Date(now.getTime() + 60_000), receipt.rowRevision);
    return receipt;
  }

  /** Join caller admission transaction; a deletion tombstone wins over a late create. */
  async receiveInput(em: EntityManager, scope: InstallationScope, input: NormalizedConversationMessage, now: Date, deadline: Date, purgeAfter: Date,
    metadataPurgeAfter = new Date(purgeAfter.getTime() + 6 * 86400_000), owner: 'community' | 'administration' = 'community'): Promise<{ eventId: string; revision: number; receipt: IntakeDelivery } | null> {
    const sourceKey = `${input.channelId}:${input.messageId}`;
    const existing = await em.findOne(IntakeEvent, { installationId: scope.installationId, sourceKey }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (existing) return null;
    const event = new IntakeEvent({
      ...scope, createdAt: now, eventKind: 'message_create', sourceEventKey: `create:${sourceKey}`, sourceKey,
      ingressSequence: BigInt(now.getTime()), observedAt: now, messageCreatedAt: input.createdAt,
      authorKind: 'user', authorUserId: input.authorId, contentAccess: 'available', coverage: ['text'],
      snapshot: { schemaVersion: 1, fields: { text: input.text } }, contentHash: input.sourceHash,
      purgeAfter, metadataPurgeAfter,
    });
    event.markCurrent(1, 'present');
    const receipt = new IntakeDelivery({ ...scope, createdAt: now, eventId: event.id, owner, orderKey: sourceKey, processingDeadline: deadline });
    receipt.claim('bot-admission', now, deadline, receipt.rowRevision);
    em.persist([event, receipt]);
    return { eventId: event.id, revision: event.sourceVersion, receipt };
  }

  /** Keep original bytes immutable; mark them unusable for current-source work. */
  async invalidate(em: EntityManager, scope: InstallationScope, reference: MessageReference, now: Date): Promise<string | null> {
    const sourceKey = `${reference.channelId}:${reference.messageId}`;
    const context = await em.findOne(IntakeEvent, { ...scope, sourceKey: `context:${sourceKey}` }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (context) context.sourceValidity = 'unresolved';
    const event = await em.findOne(IntakeEvent, { installationId: scope.installationId, sourceKey, isCurrentSourceMarker: true }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (event) { event.sourceValidity = 'unresolved'; return event.id; }
    // A create arriving after an uncached edit/delete must not resurrect obsolete work.
    const tombstone = new IntakeEvent({ ...scope, createdAt: now, eventKind: 'message_update', sourceEventKey: `invalidate:${sourceKey}`, sourceKey,
      ingressSequence: BigInt(now.getTime()), observedAt: now, authorKind: 'unknown', contentAccess: 'unknown', coverage: [],
      purgeAfter: new Date(now.getTime() + 86400_000), metadataPurgeAfter: new Date(now.getTime() + 7 * 86400_000) });
    tombstone.markCurrent(1, 'unresolved');
    em.persist(tombstone);
    return tombstone.id;
  }

  /** Bind current REST context separately from original moderation evidence; tombstones win over late history reads. */
  async bindChatContext(em: EntityManager, scope: InstallationScope, context: ChatContext, now: Date, retention: IntakeRetention): Promise<{
    context: ChatContext; bindings: { owner: 'intake'; recordId: string; revision: number; contentHash: string }[];
  }> {
    invariant(em.isInTransaction() && context.guildId === scope.guildId, 'Context requires the scoped admission transaction');
    const messages: ChatContext['messages'][number][] = [], bindings: { owner: 'intake'; recordId: string; revision: number; contentHash: string }[] = [];
    for (const message of context.messages) {
      const sourceKey = `${context.channelId}:${message.id}`;
      const source = await em.findOne(IntakeEvent, { ...scope, sourceKey, isCurrentSourceMarker: true });
      if (source && source.sourceValidity !== 'present') continue;
      let event = await em.findOne(IntakeEvent, { ...scope, sourceKey: `context:${sourceKey}` }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (event && (event.sourceValidity !== 'present' || event.contentHash !== message.contentHash || event.authorUserId !== message.authorId
        || event.payloadPurgedAt || event.purgeAfter <= now)) continue;
      if (!event) {
        event = new IntakeEvent({ ...scope, createdAt: now, eventKind: 'message_create', sourceEventKey: `context:${sourceKey}`,
          sourceKey: `context:${sourceKey}`, ingressSequence: BigInt(now.getTime()), observedAt: now, messageCreatedAt: new Date(message.createdAt),
          authorKind: message.isYuna ? 'bot' : 'user', authorUserId: message.authorId, contentAccess: 'available', coverage: ['current_context'],
          snapshot: { schemaVersion: 1, fields: { text: message.content } }, contentHash: message.contentHash, ...retention });
        event.markCurrent(1, 'present'); em.persist(event);
      }
      messages.push(message);
      bindings.push({ owner: 'intake', recordId: event.id, revision: event.sourceVersion, contentHash: event.contentHash! });
    }
    return { context: { ...context, messages }, bindings };
  }

  /** All copied current-message bindings must remain present at acceptance and dispatch, not just the triggering message. */
  async validateContextBindings(em: EntityManager, scope: InstallationScope,
    bindings: readonly { owner: string; recordId: string; revision: number; contentHash: string }[] | null): Promise<boolean> {
    if (!bindings) return false;
    for (const binding of bindings.filter(value => value.owner === 'intake')) {
      const current = await this.current(em, scope, binding.recordId, binding.revision);
      if (!current || current.hash !== binding.contentHash) return false;
    }
    return true;
  }

  /** Row lock serializes worker disclosure, source invalidation and reply dispatch. */
  async current(em: EntityManager, scope: InstallationScope, eventId: string, revision: number): Promise<{ hash: string } | null> {
    const event = await em.findOne(IntakeEvent, { ...scope, id: eventId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return event?.isCurrentSourceMarker && event.sourceValidity === 'present' && event.sourceVersion === revision && event.contentHash !== null && event.payloadPurgedAt === null && event.purgeAfter > new Date()
      ? { hash: event.contentHash } : null;
  }

  /** Purge bounded batches; metadata deduplication markers remain after text is erased. */
  async purgeExpired(em: EntityManager, scope: InstallationScope, now: Date): Promise<void> {
    const rows = await em.find(IntakeEvent, { ...scope, payloadPurgedAt: null, purgeAfter: { $lte: now } }, { limit: 50 });
    for (const row of rows) row.purgePayload(now, 'retention');
  }

  /** Removal erases bounded payload batches while preserving explicit replay/deduplication metadata. */
  async cleanupForRemoval(em: EntityManager, scope: InstallationScope, now: Date): Promise<{ disposition: 'pending' | 'retained' | 'complete'; reasonCode: string | null }> {
    const rows = await em.find(IntakeEvent, { ...scope, payloadPurgedAt: null }, { limit: 50, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const row of rows) row.purgePayload(now, 'guild_removal');
    await em.flush();
    if (await em.count(IntakeEvent, { ...scope, payloadPurgedAt: null })) return { disposition: 'pending', reasonCode: 'intake_payloads_pending' };
    return await em.count(IntakeEvent, scope) ? { disposition: 'retained', reasonCode: 'intake_replay_metadata' } : { disposition: 'complete', reasonCode: null };
  }

  /** Delete expired replay metadata only after all receipts finish and every durable source reference is gone. */
  async purgeMetadata(em: EntityManager, scope: InstallationScope, now: Date): Promise<number> {
    invariant(em.isInTransaction(), 'Metadata retention requires owner transaction');
    // These FK existence checks inspect reference identity only; payload interpretation remains with each owner.
    const rows = await em.execute<{ id: string }[]>(`select e.id from intake_event e
      where e.installation_id = ? and e.guild_id = ? and e.payload_purged_at is not null and e.metadata_purge_after <= ?
      and not exists (select 1 from intake_delivery d where d.installation_id = e.installation_id and d.event_id = e.id and d.state <> 'DONE')
      and not exists (select 1 from prepared_input p where p.installation_id = e.installation_id and p.source_event_id = e.id)
      and not exists (select 1 from moderation_case c where c.installation_id = e.installation_id and c.original_event_id = e.id)
      and not exists (select 1 from evidence_revision v where v.installation_id = e.installation_id and v.original_event_id = e.id)
      and not exists (select 1 from channel_chore c where c.installation_id = e.installation_id and c.source_event_id = e.id)
      order by e.id limit 50 for update of e`, [scope.installationId, scope.guildId, now]);
    for (const row of rows) {
      await em.nativeDelete(IntakeDelivery, { ...scope, eventId: row.id, state: 'DONE' });
      await em.nativeDelete(IntakeEvent, { ...scope, id: row.id });
    }
    return rows.length;
  }
}
