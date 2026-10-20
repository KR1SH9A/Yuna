import type { EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import { IntakeEvent } from './entities/intake-event.entity.js';
import { IntakeDelivery } from './entities/intake-delivery.entity.js';
import type { InstallationScope } from '../../contexts/administration/guild-lifecycle.service.js';
import type { NormalizedConversationMessage, MessageReference } from '../../discord/contracts.js';

/** Platform intake owns immutable message observations and current-source validity. */
export class IntakeService {
  /** Join caller admission transaction; a deletion tombstone wins over a late create. */
  async receiveInput(em: EntityManager, scope: InstallationScope, input: NormalizedConversationMessage, now: Date, deadline: Date, purgeAfter: Date): Promise<{ eventId: string; revision: number; receipt: IntakeDelivery } | null> {
    const sourceKey = `${input.channelId}:${input.messageId}`;
    const existing = await em.findOne(IntakeEvent, { installationId: scope.installationId, sourceKey }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (existing) return null;
    const event = new IntakeEvent({
      ...scope, createdAt: now, eventKind: 'message_create', sourceEventKey: `create:${sourceKey}`, sourceKey,
      ingressSequence: BigInt(now.getTime()), observedAt: now, messageCreatedAt: input.createdAt,
      authorKind: 'user', authorUserId: input.authorId, contentAccess: 'available', coverage: ['text'],
      snapshot: { schemaVersion: 1, fields: { text: input.text } }, contentHash: input.sourceHash,
      purgeAfter, metadataPurgeAfter: new Date(purgeAfter.getTime() + 6 * 86400_000),
    });
    event.markCurrent(1, 'present');
    const receipt = new IntakeDelivery({ ...scope, createdAt: now, eventId: event.id, owner: 'community', orderKey: sourceKey, processingDeadline: deadline });
    receipt.claim('bot-admission', now, deadline, receipt.rowRevision);
    em.persist([event, receipt]);
    return { eventId: event.id, revision: event.sourceVersion, receipt };
  }

  /** Keep original bytes immutable; mark them unusable for current-source work. */
  async invalidate(em: EntityManager, scope: InstallationScope, reference: MessageReference, now: Date): Promise<string | null> {
    const sourceKey = `${reference.channelId}:${reference.messageId}`;
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

  /** Row lock serializes worker disclosure, source invalidation and reply dispatch. */
  async current(em: EntityManager, scope: InstallationScope, eventId: string, revision: number): Promise<{ hash: string } | null> {
    const event = await em.findOne(IntakeEvent, { ...scope, id: eventId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return event?.isCurrentSourceMarker && event.sourceValidity === 'present' && event.sourceVersion === revision && event.contentHash !== null && event.payloadPurgedAt === null
      ? { hash: event.contentHash } : null;
  }

  /** Purge bounded batches; metadata deduplication markers remain after text is erased. */
  async purgeExpired(em: EntityManager, scope: InstallationScope, now: Date): Promise<void> {
    const rows = await em.find(IntakeEvent, { ...scope, payloadPurgedAt: null, purgeAfter: { $lte: now } }, { limit: 50 });
    for (const row of rows) row.purgePayload(now, 'retention');
  }
}
