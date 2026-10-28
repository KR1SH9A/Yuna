/** Own explicit private user memory, consent fences, bounded inspection and atomic physical erasure. */
import { createHash } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { assertDate, assertDiscordId, assertUuid, invariant } from '../../platform/db/entity-values.js';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import type { TrustedCallerContext } from '../administration/contracts.js';
import { MemoryScope } from './entities/memory-scope.entity.js';
import { MemoryFact } from './entities/memory-fact.entity.js';
import { MemoryDeletionRequest } from './entities/memory-deletion-request.entity.js';
import { MemoryPolicy } from './memory.policy.js';
import { maximumMemoryFacts, memoryPageSize, memoryPurpose } from './contracts.js';
import type { SetMemoryConsentRequestDto, MemoryConsentResponseDto } from './dto/memory-consent.dto.js';
import type { ForgetMemoryRequestDto, MemoryDeletionResponseDto } from './dto/forget-memory.dto.js';
import type { InspectMemoryRequestDto, OwnMemoryFactsResponseDto, RememberMemoryRequestDto, RememberMemoryResponseDto } from './dto/inspect-memory.dto.js';

export class MemoryService {
  /** Private facts never enter Jobs or public conversation context in this explicit-submission route. */
  constructor(private readonly orm: MikroORM, private readonly scope: InstallationScope,
    private readonly administration: GuildLifecycleService, private readonly audit = new AuditRecorder(),
    private readonly policy = new MemoryPolicy()) {}

  /** Grant explicit private consent; withdrawal or a shorter retention period physically erases prior facts. */
  async setConsent(trustedCaller: TrustedCallerContext, value: SetMemoryConsentRequestDto): Promise<MemoryConsentResponseDto> {
    const caller = this.caller(trustedCaller), input = { ...value };
    this.fields(input, ['granted', 'retentionDays', 'expectedPrivacyRevision']); this.revision(input.expectedPrivacyRevision);
    invariant(typeof input.granted === 'boolean' && Number.isInteger(input.retentionDays) && input.retentionDays >= 1 && input.retentionDays <= 30, 'Invalid memory consent');
    return this.orm.em.fork().transactional(async em => {
      if (input.granted) invariant(await this.administration.lockFeatureAdmission(em, this.scope, 'memory'), 'Memory admission is closed');
      else await this.administration.lockPrivacy(em, this.scope);
      const now = new Date(), scope = await this.lockScope(em, caller.actorId, now);
      const prior = scope.purposeConsents[memoryPurpose];
      if (prior?.sourceRequestId === caller.sourceRequestId) {
        invariant(prior.granted === input.granted && scope.retentionConfiguration.maxAgeSeconds === input.retentionDays * 86400,
          'Consent replay differs from its original request');
        return this.consent(scope);
      }
      invariant(scope.privacyRevision === input.expectedPrivacyRevision, 'Stale privacy revision');
      const erase = !input.granted || input.retentionDays * 86400 < scope.retentionConfiguration.maxAgeSeconds;
      let erasedFacts = 0;
      if (erase) {
        const facts = await em.find(MemoryFact, { ...this.scope, scopeId: scope.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (facts.length) { await this.erase(em, scope, facts, now, 'consent_changed'); erasedFacts = facts.length; }
      }
      scope.revisePrivacy({ purposeConsents: { [memoryPurpose]: { granted: input.granted, changedAt: now.toISOString(), sourceRequestId: caller.sourceRequestId } },
        allowedAudiences: [{ kind: 'subject' }], retentionConfiguration: { maxAgeSeconds: input.retentionDays * 86400 } }, scope.privacyRevision, now);
      await this.auditChange(em, scope, 'memory.consent', now);
      return { ...this.consent(scope), erasedFacts };
    });
  }

  /** Accept only the authenticated member's exact submitted text; no model inference or source-message scraping occurs. */
  async remember(trustedCaller: TrustedCallerContext, value: RememberMemoryRequestDto): Promise<RememberMemoryResponseDto> {
    const caller = this.caller(trustedCaller), input = { ...value };
    this.fields(input, ['text', 'expectedPrivacyRevision']); this.revision(input.expectedPrivacyRevision);
    invariant(typeof input.text === 'string' && input.text.trim().length > 0 && input.text.length <= 500 && !input.text.includes('\0'), 'Memory text must contain 1 to 500 characters');
    const contentHash = createHash('sha256').update(input.text).digest('hex');
    return this.orm.em.fork().transactional(async em => {
      invariant(await this.administration.lockFeatureAdmission(em, this.scope, 'memory'), 'Memory admission is closed');
      const now = new Date(), scope = await this.lockScope(em, caller.actorId, now);
      invariant(this.policy.canStore(scope), 'Explicit private memory consent is required');
      invariant(scope.privacyRevision === input.expectedPrivacyRevision, 'Stale privacy revision');
      const existing = await em.findOne(MemoryFact, { ...this.scope, scopeId: scope.id, acceptanceOperationKey: caller.sourceRequestId, proposalItemKey: 'submitted' });
      if (existing) {
        invariant(existing.contentHash === contentHash && existing.factText === input.text && existing.expiresAt > now, 'Memory replay differs or has expired');
        return { factId: existing.id, privacyRevision: scope.privacyRevision, expiresAt: existing.expiresAt.toISOString(), duplicate: true };
      }
      invariant(await em.count(MemoryFact, { ...this.scope, scopeId: scope.id }) < maximumMemoryFacts, 'Private memory limit reached; forget a fact first');
      const fact = new MemoryFact({ ...this.scope, createdAt: now, scopeId: scope.id, subjectUserId: caller.actorId, purpose: memoryPurpose,
        consentRevision: scope.privacyRevision, factText: input.text, contentHash, audience: { kind: 'subject' },
        sourceProvenance: [{ kind: 'user_submission', sourceRequestId: caller.sourceRequestId, channelId: null, messageId: null, sourceVersion: null }],
        acceptedTaskResultId: null, acceptanceOperationKey: caller.sourceRequestId, proposalItemKey: 'submitted', replacesFactId: null,
        acceptedAt: now, expiresAt: new Date(now.getTime() + scope.retentionConfiguration.maxAgeSeconds * 1000) });
      em.persist(fact);
      await this.auditChange(em, scope, 'memory.remember', now, fact.id);
      return { factId: fact.id, privacyRevision: scope.privacyRevision, expiresAt: fact.expiresAt.toISOString(), duplicate: false };
    });
  }

  /** Inspect/search only private facts belonging to the caller; the transport must deliver this view ephemerally. */
  async inspectOwnFacts(trustedCaller: TrustedCallerContext, value: InspectMemoryRequestDto = {}): Promise<OwnMemoryFactsResponseDto> {
    const caller = this.caller(trustedCaller), input = { ...value };
    this.fields(input, ['query', 'offset']);
    invariant(input.query === undefined || typeof input.query === 'string' && input.query.length <= 100, 'Memory search is too long');
    const offset = input.offset ?? 0;
    invariant(Number.isInteger(offset) && offset >= 0 && offset <= maximumMemoryFacts, 'Invalid memory page');
    return this.orm.em.fork().transactional(async em => {
      await this.administration.lockPrivacy(em, this.scope);
      const scope = await em.findOne(MemoryScope, { ...this.scope, userId: caller.actorId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!scope) return { granted: false, retentionDays: 30, privacyRevision: 0, erasedFacts: 0, facts: [], nextOffset: null };
      const now = new Date(), query = input.query?.toLowerCase() ?? '';
      const all = await em.find(MemoryFact, { ...this.scope, scopeId: scope.id }, { orderBy: { acceptedAt: 'asc', id: 'asc' }, limit: maximumMemoryFacts });
      const matching = all.filter(fact => this.policy.canDisclose(scope, fact, caller.actorId, now) && fact.factText.toLowerCase().includes(query));
      const facts = matching.slice(offset, offset + memoryPageSize).map(fact => ({ factId: fact.id, text: fact.factText,
        acceptedAt: fact.acceptedAt.toISOString(), expiresAt: fact.expiresAt.toISOString() }));
      return { ...this.consent(scope), facts, nextOffset: offset + facts.length < matching.length ? offset + facts.length : null };
    });
  }

  /** Advance the privacy fence and erase exact scoped content in one commit; another user's fact ID is rejected. */
  async forget(trustedCaller: TrustedCallerContext, value: ForgetMemoryRequestDto): Promise<MemoryDeletionResponseDto> {
    const caller = this.caller(trustedCaller), input = { ...value };
    this.fields(input, ['expectedPrivacyRevision', 'factId']); this.revision(input.expectedPrivacyRevision);
    if (input.factId !== undefined) assertUuid(input.factId);
    return this.orm.em.fork().transactional(async em => {
      await this.administration.lockPrivacy(em, this.scope);
      const now = new Date(), scope = await this.lockScope(em, caller.actorId, now);
      invariant(scope.privacyRevision === input.expectedPrivacyRevision, 'Stale privacy revision');
      const facts = await em.find(MemoryFact, { ...this.scope, scopeId: scope.id, ...(input.factId ? { id: input.factId } : {}) }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (input.factId) invariant(facts.length === 1, 'Fact does not belong to this private scope');
      const receipt = await this.erase(em, scope, facts, now, 'user_forgot');
      return { deletionId: receipt.id, privacyRevision: scope.privacyRevision, erasedFacts: facts.length, state: 'complete' };
    });
  }

  /** Expiry removes content without waiting for feature admission; completed non-content receipts expire separately. */
  async runRetention(at = new Date()): Promise<number> {
    assertDate(at, 'at');
    return this.orm.em.fork().transactional(async em => {
      await this.administration.lockPrivacy(em, this.scope);
      const expired = await em.find(MemoryFact, { ...this.scope, expiresAt: { $lte: at } }, { orderBy: { expiresAt: 'asc' }, limit: 100 });
      const scopeIds = [...new Set(expired.map(fact => fact.scopeId))];
      for (const id of scopeIds) {
        const scope = await em.findOneOrFail(MemoryScope, { ...this.scope, id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        await this.erase(em, scope, expired.filter(fact => fact.scopeId === id), at, 'memory_expired');
      }
      await em.nativeDelete(MemoryDeletionRequest, { ...this.scope, state: 'complete', purgeAfter: { $lte: at } });
      return expired.length;
    });
  }

  /** Removal revokes private consent in bounded batches and erases all owned fact content before acknowledging cleanup. */
  async cleanupForRemoval(em: EntityManager, at: Date): Promise<{ disposition: 'complete' | 'pending'; reasonCode: string }> {
    invariant(em.isInTransaction(), 'Memory removal requires the caller transaction'); assertDate(at, 'at');
    await this.administration.lockPrivacy(em, this.scope);
    const scopes = await em.find(MemoryScope, { ...this.scope, purposeConsents: { [memoryPurpose]: { granted: true } } },
      { orderBy: { id: 'asc' }, limit: 100, lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const scope of scopes) {
      const facts = await em.find(MemoryFact, { ...this.scope, scopeId: scope.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      await this.erase(em, scope, facts, at, 'installation_removed');
      scope.revisePrivacy({ purposeConsents: { [memoryPurpose]: { granted: false, changedAt: at.toISOString(), sourceRequestId: 'installation-removal' } },
        allowedAudiences: [{ kind: 'subject' }], retentionConfiguration: scope.retentionConfiguration }, scope.privacyRevision, at);
    }
    // No live fact can remain outside a consent scope, but erase any residual expired content defensively.
    await em.nativeDelete(MemoryFact, this.scope);
    return { disposition: scopes.length === 100 ? 'pending' : 'complete', reasonCode: 'private_memory_erased' };
  }

  /** Shared installation locks serialize initial scope creation; this row survives deletion as the no-resurrection fence. */
  private async lockScope(em: EntityManager, userId: string, at: Date): Promise<MemoryScope> {
    let scope = await em.findOne(MemoryScope, { ...this.scope, userId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!scope) {
      scope = new MemoryScope({ ...this.scope, createdAt: at, userId, privacy: { purposeConsents: {}, allowedAudiences: [{ kind: 'subject' }], retentionConfiguration: { maxAgeSeconds: 30 * 86400 } } });
      em.persist(scope);
    }
    return scope;
  }

  /** Physical erasure and its completed receipt are atomic because this route creates no provider/public copies or vectors. */
  private async erase(em: EntityManager, scope: MemoryScope, facts: readonly MemoryFact[], at: Date, reason: string): Promise<MemoryDeletionRequest> {
    const generation = scope.advanceDeletionFence(scope.privacyRevision, at);
    for (const fact of facts) { invariant(fact.scopeId === scope.id && fact.subjectUserId === scope.userId, 'Foreign memory deletion'); em.remove(fact); }
    const policy = await this.administration.readPolicyConfig(em, this.scope);
    const receipt = new MemoryDeletionRequest({ ...this.scope, createdAt: at, scopeId: scope.id, deletionGeneration: generation,
      selection: facts.length ? { kind: 'facts', factIds: facts.map(fact => fact.id) } : { kind: 'scope_cutoff', acceptedBefore: at.toISOString() },
      requiredOwners: ['memory'], requestedAt: at, purgeAfter: new Date(at.getTime() + policy.retention.metadataDays * 86400_000) });
    receipt.recordOwnerProgress('memory', generation, { disposition: 'deleted', outstandingReferences: [], reasonCode: reason, recordedAt: at.toISOString() }, at);
    receipt.markCompleted(at); em.persist(receipt);
    await this.auditChange(em, scope, 'memory.forget', at, receipt.id);
    return receipt;
  }

  /** Keep only non-content references in audit; saved text, search terms and deleted text are never copied. */
  private async auditChange(em: EntityManager, scope: MemoryScope, operation: string, at: Date, recordId = scope.id): Promise<void> {
    const policy = await this.administration.readPolicyConfig(em, this.scope);
    await this.audit.recordTransition(em, { ...this.scope, createdAt: at, occurredAt: at, origin: { kind: 'user', userId: scope.userId },
      operation, outcome: 'succeeded', references: [{ owner: 'memory', recordId, revision: scope.privacyRevision }],
      correlationId: recordId, idempotencyKey: `${operation}:${recordId}:${scope.privacyRevision}`,
      purgeAfter: new Date(at.getTime() + policy.retention.metadataDays * 86400_000) });
  }

  /** Every external method derives its subject exclusively from trusted ingress and the running installation. */
  private caller(value: TrustedCallerContext): TrustedCallerContext {
    assertDiscordId(value.actorId); assertDiscordId(value.guildId); assertUuid(value.installationId);
    invariant(value.installationId === this.scope.installationId && value.guildId === this.scope.guildId, 'Memory scope mismatch');
    invariant(typeof value.sourceRequestId === 'string' && value.sourceRequestId.length > 0 && value.sourceRequestId.length <= 200, 'Invalid memory request identity');
    return Object.freeze({ ...value });
  }

  /** Reject identity/authority injection and unknown options even when a caller bypasses the command parser. */
  private fields(value: object, allowed: readonly string[]): void { invariant(Object.keys(value).every(key => allowed.includes(key)), 'Unknown memory request field'); }

  /** Revisions are bounded to PostgreSQL integers so stale operations cannot wrap the privacy fence. */
  private revision(value: number): void { invariant(Number.isInteger(value) && value >= 0 && value <= 2147483647, 'Invalid privacy revision'); }

  /** A plain consent view contains no fact content and no reusable disclosure authority. */
  private consent(scope: MemoryScope): MemoryConsentResponseDto {
    return { granted: this.policy.canStore(scope), retentionDays: scope.retentionConfiguration.maxAgeSeconds / 86400,
      privacyRevision: scope.privacyRevision, erasedFacts: 0 };
  }
}
