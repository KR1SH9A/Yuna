/** Community-owned approved knowledge: immutable content, separately authorized audience changes, and bounded retrieval. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { AuthorityService } from '../administration/authority.service.js';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import type { AuthorityOperation, CurrentNativeFacts, TrustedCallerContext } from '../administration/contracts.js';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { assertDate, assertUuid, copyJson, invariant } from '../../platform/db/entity-values.js';
import { KnowledgeEntry, type KnowledgeVisibility } from './entities/knowledge-entry.entity.js';
import { validateAudience, type AudienceBinding, type ContextBinding } from './entities/community-values.js';
import { parseApproveKnowledgeEntry, parseChangeKnowledgeVisibility, parseRetireKnowledgeEntry, parseVisibleKnowledgeQuery,
  type KnowledgeEntryDto, type VisibleKnowledgeQueryDto } from './dto/knowledge.dto.js';

/** Community cancels pending tasks and unsent copies that reference these exact knowledge entries in the same transaction. */
export type InvalidateKnowledgeUses = (em: EntityManager, entryIds: readonly string[], reason: string, at: Date) => Promise<void>;
interface AuthorizedScope { operation: AuthorityOperation; facts: CurrentNativeFacts }

export class KnowledgeService {
  /** A required owner callback ensures retirement cannot leave already prepared copies available for later disclosure. */
  constructor(private readonly orm: MikroORM, readonly scope: InstallationScope, private readonly authority: AuthorityService,
    private readonly lifecycle: GuildLifecycleService, private readonly invalidateUses: InvalidateKnowledgeUses,
    private readonly audit = new AuditRecorder()) { invariant(typeof invalidateUses === 'function', 'Knowledge invalidation is required'); }

  /** Approve exact content once; corrections create a new row and retire the expected predecessor atomically. */
  async approveEntry(trustedCaller: TrustedCallerContext, value: unknown): Promise<KnowledgeEntryDto> {
    const caller = this.caller(trustedCaller), input = parseApproveKnowledgeEntry(value);
    const previous = input.predecessor ? await this.readEntryScope(input.predecessor.entryId) : null;
    const facts = await this.readAuthority(caller, [input.visibility, ...(previous ? [previous.visibility] : [])]);
    return this.orm.em.fork().transactional(async em => {
      await this.authorize(em, caller, facts);
      const now = new Date(), id = approvalId(caller), existing = await em.findOne(KnowledgeEntry, { ...this.scope, id });
      const predecessor = input.predecessor ? await em.findOneOrFail(KnowledgeEntry, { ...this.scope, id: input.predecessor.entryId }, { lockMode: LockMode.PESSIMISTIC_WRITE }) : null;
      if (existing) {
        const replacementFrom = await em.findOne(KnowledgeEntry, { ...this.scope, replacementEntryId: existing.id });
        invariant(existing.content === input.content && existing.approvalActorId === caller.actorId
          && existing.provenance?.requestId === caller.sourceRequestId && existing.provenance.kind === input.provenance.kind
          && existing.provenance.sourceReference === input.provenance.sourceReference && isDeepStrictEqual(existing.visibility, input.visibility)
          && (replacementFrom?.id ?? null) === (predecessor?.id ?? null)
          && (predecessor === null || predecessor.replacementEntryId === existing.id), 'Knowledge approval replay mismatch');
        return view(existing);
      }
      if (predecessor) invariant(predecessor.rowRevision === input.predecessor!.expectedRowRevision
        && isDeepStrictEqual(predecessor.visibility, previous!.visibility), 'Stale knowledge predecessor revision');
      const policy = await this.lifecycle.readPolicyConfig(em, this.scope);
      const entry = new KnowledgeEntry({ ...this.scope, id, createdAt: now, content: input.content,
        provenance: { schemaVersion: 1, ...input.provenance, requestId: caller.sourceRequestId }, approvalActorId: caller.actorId,
        approvedAt: now, visibility: input.visibility, purgeAfter: new Date(now.getTime() + policy.retention.payloadDays * 86_400_000) });
      if (predecessor) {
        predecessor.retire(input.predecessor!.expectedRowRevision, now, entry);
        await this.invalidateUses(em, [predecessor.id], 'knowledge_replaced', now);
      }
      em.persist(entry);
      await this.audit.recordControlChange(em, caller, 'community.knowledge_approved', [{ owner: 'knowledge', recordId: entry.id, revision: entry.rowRevision },
        ...(predecessor ? [{ owner: 'knowledge', recordId: predecessor.id, revision: predecessor.rowRevision }] : [])], now, policy.retention.metadataDays);
      return view(entry);
    });
  }

  /** Authorize both old and new audiences before changing visibility; content and approval metadata remain immutable. */
  async changeVisibility(trustedCaller: TrustedCallerContext, value: unknown): Promise<KnowledgeEntryDto> {
    const caller = this.caller(trustedCaller), input = parseChangeKnowledgeVisibility(value), previous = await this.readEntryScope(input.entryId);
    const facts = await this.readAuthority(caller, [previous.visibility, input.visibility]);
    return this.orm.em.fork().transactional(async em => {
      await this.authorize(em, caller, facts);
      const entry = await em.findOneOrFail(KnowledgeEntry, { ...this.scope, id: input.entryId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      invariant(entry.rowRevision === input.expectedRowRevision && isDeepStrictEqual(entry.visibility, previous.visibility), 'Stale knowledge revision');
      const now = new Date(); entry.changeVisibility(input.visibility, input.expectedRowRevision, now);
      await this.invalidateUses(em, [entry.id], 'knowledge_visibility_changed', now);
      await this.recordChange(em, caller, 'community.knowledge_visibility', entry, now);
      return view(entry);
    });
  }

  /** Retirement excludes future retrieval and invalidates every pending use before the transaction can commit. */
  async retireEntry(trustedCaller: TrustedCallerContext, value: unknown): Promise<KnowledgeEntryDto> {
    const caller = this.caller(trustedCaller), input = parseRetireKnowledgeEntry(value), previous = await this.readEntryScope(input.entryId);
    const facts = await this.readAuthority(caller, [previous.visibility]);
    return this.orm.em.fork().transactional(async em => {
      await this.authorize(em, caller, facts);
      const entry = await em.findOneOrFail(KnowledgeEntry, { ...this.scope, id: input.entryId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      invariant(entry.rowRevision === input.expectedRowRevision && isDeepStrictEqual(entry.visibility, previous.visibility), 'Stale knowledge revision');
      const now = new Date(); entry.retire(input.expectedRowRevision, now);
      await this.invalidateUses(em, [entry.id], input.reasonCode, now);
      await this.recordChange(em, caller, 'community.knowledge_retired', entry, now);
      return view(entry);
    });
  }

  /** Staff can inspect current revisions only after fresh authority for the entry's entire approved audience. */
  async readEntry(trustedCaller: TrustedCallerContext, entryId: string): Promise<KnowledgeEntryDto> {
    const caller = this.caller(trustedCaller), previous = await this.readEntryScope(entryId);
    const facts = await this.readAuthority(caller, [previous.visibility]);
    return this.orm.em.fork().transactional(async em => {
      await this.authorize(em, caller, facts);
      const entry = await em.findOneOrFail(KnowledgeEntry, { ...this.scope, id: entryId });
      invariant(isDeepStrictEqual(entry.visibility, previous.visibility), 'Knowledge visibility changed during authorization');
      return view(entry);
    });
  }

  /** An authenticated staff lookup uses current knowledge authority for the exact channel, never a caller-asserted audience. */
  async searchEntries(trustedCaller: TrustedCallerContext, value: { search: string; channelId: string }): Promise<KnowledgeEntryDto[]> {
    const caller = this.caller(trustedCaller);
    invariant(value !== null && typeof value === 'object' && Object.keys(value).every(key => ['search', 'channelId'].includes(key)), 'Invalid knowledge lookup');
    const query = parseVisibleKnowledgeQuery({ search: value.search, limit: 5 }), channelId = value.channelId;
    const facts = await this.readAuthority(caller, [{ schemaVersion: 1, kind: 'channels', channelIds: [channelId] }]);
    return this.orm.em.fork().transactional(async em => {
      await this.authorize(em, caller, facts);
      return this.findVisibleEntries(em, query, { schemaVersion: 1, visibility: 'channel', channelId, requesterUserId: caller.actorId, revision: 1 });
    });
  }

  /** Retrieve at most five whole approved entries and 6000 content characters for an already verified channel audience. */
  async findVisibleEntries(em: EntityManager, value: VisibleKnowledgeQueryDto, audience: AudienceBinding, at = new Date()): Promise<KnowledgeEntryDto[]> {
    this.checkAudienceTransaction(em, audience, at);
    const query = parseVisibleKnowledgeQuery(value);
    if (!await this.lifecycle.lockAdmission(em, this.scope)) return [];
    const terms = [...new Set(query.search.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 20);
    if (!terms.length) return [];
    // Filter visibility in SQL before loading content. A finite newest-first candidate window avoids an unbounded scan in application memory.
    const ids = await em.execute<{ id: string }[]>(`select id from knowledge_entry where installation_id=? and guild_id=?
      and retired_at is null and payload_purged_at is null and approved_at<=? and purge_after>?
      and (visibility->>'kind'='guild' or (visibility->>'kind'='channels' and (visibility->'channelIds') @> ?::jsonb))
      ${query.entryIds?.length ? 'and id::text in (select jsonb_array_elements_text(?::jsonb))' : ''}
      order by approved_at desc,id asc limit 200`, [this.scope.installationId, this.scope.guildId, at, at, JSON.stringify([audience.channelId]),
      ...(query.entryIds?.length ? [JSON.stringify(query.entryIds)] : [])]);
    const filteredIds = ids.map(row => row.id).filter(id => !query.entryIds?.length || query.entryIds.includes(id));
    if (!filteredIds.length) return [];
    const entries = await em.find(KnowledgeEntry, { ...this.scope, id: { $in: filteredIds } });
    const scored = entries.filter(entry => usable(entry, audience, at)).map(entry => ({ entry,
      score: terms.reduce((total, term) => total + (entry.content!.toLocaleLowerCase('en-US').includes(term) ? 1 : 0), 0) }))
      .filter(item => item.score > 0).sort((left, right) => right.score - left.score || right.entry.approvedAt.getTime() - left.entry.approvedAt.getTime() || left.entry.id.localeCompare(right.entry.id));
    const result: KnowledgeEntryDto[] = []; let remaining = 6_000;
    for (const { entry } of scored) {
      if (result.length >= query.limit) break;
      if (entry.content!.length > remaining) continue;
      remaining -= entry.content!.length; result.push(view(entry));
    }
    return result;
  }

  /** Acceptance and delivery recheck immutable content hashes plus current visibility, expiry and access revisions. */
  async validateBindings(em: EntityManager, bindings: readonly ContextBinding[], audience: AudienceBinding, at = new Date()): Promise<boolean> {
    this.checkAudienceTransaction(em, audience, at);
    const knowledge = bindings.filter(binding => binding.owner === 'knowledge');
    if (!knowledge.length) return true;
    if (knowledge.length > 5 || new Set(knowledge.map(binding => binding.recordId)).size !== knowledge.length) return false;
    if (!await this.lifecycle.lockAdmission(em, this.scope, 'continuation')) return false;
    for (const binding of knowledge) {
      assertUuid(binding.recordId);
      const entry = await em.findOne(KnowledgeEntry, { ...this.scope, id: binding.recordId });
      if (!entry || !usable(entry, audience, at) || entry.rowRevision !== binding.revision || entry.contentHash !== binding.contentHash) return false;
    }
    return true;
  }

  /** Retention erases expired approved text only after invalidating its pending copies, in bounded owner transactions. */
  async purgeExpired(em: EntityManager, at = new Date(), limit = 50): Promise<number> {
    invariant(em.isInTransaction(), 'Knowledge retention requires the owner transaction'); assertDate(at, 'at');
    invariant(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Invalid knowledge cleanup limit');
    await this.lifecycle.lockPrivacy(em, this.scope);
    const rows = await em.find(KnowledgeEntry, { ...this.scope, payloadPurgedAt: null, purgeAfter: { $lte: at } }, { limit, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    if (rows.length) await this.invalidateUses(em, rows.map(row => row.id), 'knowledge_expired', at);
    for (const row of rows) row.purgePayload('retention', row.rowRevision, at);
    return rows.length;
  }

  /** Installation removal erases knowledge payloads while retaining only the old generation's minimal lineage. */
  async cleanupForRemoval(em: EntityManager, at = new Date()): Promise<{ disposition: 'pending' | 'retained' | 'complete'; reasonCode: string | null }> {
    invariant(em.isInTransaction(), 'Knowledge removal requires the owner transaction'); assertDate(at, 'at');
    const rows = await em.find(KnowledgeEntry, { ...this.scope, payloadPurgedAt: null }, { limit: 50, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    if (rows.length) await this.invalidateUses(em, rows.map(row => row.id), 'installation_removal', at);
    for (const row of rows) row.purgePayload('installation_removal', row.rowRevision, at);
    await em.flush();
    if (await em.count(KnowledgeEntry, { ...this.scope, payloadPurgedAt: null })) return { disposition: 'pending', reasonCode: 'knowledge_payload_cleanup' };
    return await em.count(KnowledgeEntry, this.scope) ? { disposition: 'retained', reasonCode: 'knowledge_lineage' } : { disposition: 'complete', reasonCode: null };
  }

  /** Bind trusted caller provenance to this immutable installation before looking up any content. */
  private caller(value: TrustedCallerContext): TrustedCallerContext {
    invariant(value.installationId === this.scope.installationId && value.guildId === this.scope.guildId, 'Wrong knowledge installation');
    return Object.freeze({ ...value });
  }

  /** Read only the expected entry scope before external facts; the locked transaction later rechecks its revision and visibility. */
  private async readEntryScope(id: string): Promise<{ visibility: KnowledgeVisibility }> {
    assertUuid(id);
    const row = await this.orm.em.fork().findOneOrFail(KnowledgeEntry, { ...this.scope, id }, { fields: ['visibility'] });
    return { visibility: copyJson(row.visibility) };
  }

  /** Fetch current native facts for every old/new audience before entering a database transaction. */
  private async readAuthority(caller: TrustedCallerContext, audiences: KnowledgeVisibility[]): Promise<AuthorizedScope[]> {
    const operations: AuthorityOperation[] = [
      ...(audiences.some(audience => audience.kind === 'guild') ? [{ capability: 'knowledge.manage' as const }] : []),
      ...[...new Set(audiences.flatMap(audience => audience.kind === 'channels' ? audience.channelIds : []))].sort()
        .map(channelId => ({ capability: 'knowledge.manage' as const, channelId })),
    ];
    return Promise.all(operations.map(async operation => ({ operation, facts: await this.authority.readCurrentFacts(caller, operation) })));
  }

  /** Lock installation, safety and application grants through Administration, rechecking native-fact freshness after waits. */
  private async authorize(em: EntityManager, caller: TrustedCallerContext, scopes: AuthorizedScope[]): Promise<void> {
    invariant(scopes.length > 0, 'Knowledge operation requires an audience');
    for (const scope of scopes) {
      const result = await this.authority.authorizeInTransaction(em, caller, scope.operation, scope.facts);
      invariant(result.allowed, result.allowed ? '' : result.reason);
    }
  }

  /** Human requests never construct this internal audience path; Conversation supplies its verified source channel binding. */
  private checkAudienceTransaction(em: EntityManager, audience: AudienceBinding, at: Date): void {
    invariant(em.isInTransaction(), 'Knowledge retrieval requires the owner transaction'); assertDate(at, 'at'); validateAudience(audience);
    invariant(audience.visibility === 'channel', 'Knowledge retrieval requires a verified channel audience');
  }

  /** Audit stores stable references only, with the installation's approved metadata lifetime. */
  private async recordChange(em: EntityManager, caller: TrustedCallerContext, operation: string, entry: KnowledgeEntry, at: Date): Promise<void> {
    const policy = await this.lifecycle.readPolicyConfig(em, this.scope);
    await this.audit.recordControlChange(em, caller, operation, [{ owner: 'knowledge', recordId: entry.id, revision: entry.rowRevision }], at, policy.retention.metadataDays);
  }
}

/** Request-derived UUID makes concurrent duplicate approval requests converge without a new persistence abstraction. */
function approvalId(caller: TrustedCallerContext): string {
  const bytes = createHash('sha256').update(`knowledge:${caller.installationId}:${caller.sourceRequestId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Availability and exact-channel visibility are checked again after candidate selection and before every later use. */
function usable(entry: KnowledgeEntry, audience: AudienceBinding, at: Date): boolean {
  return entry.retiredAt === null && entry.payloadPurgedAt === null && entry.approvedAt <= at && entry.purgeAfter > at
    && entry.content !== null && entry.provenance !== null && (entry.visibility.kind === 'guild'
      || (entry.visibility.kind === 'channels' && entry.visibility.channelIds.includes(audience.channelId)));
}

/** Detach mutable values from ORM state and never expose an entity or repository across the feature boundary. */
function view(entry: KnowledgeEntry): KnowledgeEntryDto {
  const retained = entry.purgeAfter > new Date() && entry.payloadPurgedAt === null;
  return { entryId: entry.id, content: retained ? entry.content : null, contentHash: entry.contentHash, rowRevision: entry.rowRevision,
    provenance: retained && entry.provenance ? copyJson(entry.provenance) : null, visibility: copyJson(entry.visibility), approvalActorId: entry.approvalActorId,
    approvedAt: entry.approvedAt.toISOString(), retiredAt: entry.retiredAt?.toISOString() ?? null,
    replacementEntryId: entry.replacementEntryId, purgeAfter: entry.purgeAfter.toISOString() };
}
