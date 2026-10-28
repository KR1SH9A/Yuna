/** Append bounded audit references in the business transaction; no prompt, token or evidence payload is copied. */
import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { assertDate, assertDiscordId, assertUuid, invariant } from '../db/entity-values.js';
import { AuditEntry, type AuditEntryInput, type AuditOrigin, type AuditReference } from './entities/audit-entry.entity.js';

export class AuditRecorder {
  /** Delete a bounded page after its declared audit lifetime; effect/accounting owners retain their own unresolved references. */
  async purgeExpired(em: EntityManager, scope: { installationId: string; guildId: string }, at = new Date(), limit = 50): Promise<number> {
    invariant(em.isInTransaction(), 'Audit cleanup requires the owner transaction');
    assertUuid(scope.installationId); assertDiscordId(scope.guildId); assertDate(at, 'audit retention time');
    invariant(Number.isInteger(limit) && limit >= 1 && limit <= 500, 'Invalid audit cleanup bound');
    const rows = await em.find(AuditEntry, { ...scope, purgeAfter: { $lte: at } },
      { limit, orderBy: { purgeAfter: 'asc', id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    em.remove(rows);
    return rows.length;
  }

  /** Removal erases expired audit records and records an explicit disposition for records still inside their declared lifetime. */
  async cleanupForRemoval(em: EntityManager, scope: { installationId: string; guildId: string }, at: Date): Promise<{
    disposition: 'complete' | 'retained'; reasonCode: string;
  }> {
    await this.purgeExpired(em, scope, at);
    await em.flush();
    const remains = await em.count(AuditEntry, scope);
    return { disposition: remains ? 'retained' : 'complete', reasonCode: remains ? 'audit_retention_until_expiry' : 'audit_erased' };
  }

  /** Shared control-operation envelope keeps operator audit fields and retention consistent across owners. */
  async recordControlChange(em: EntityManager, caller: { installationId: string; guildId: string; actorId: string; sourceRequestId: string },
    operation: string, references: AuditReference[], at: Date, retentionDays = 7, operationKey = operation): Promise<string> {
    invariant(Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 3650, 'Invalid audit retention');
    return this.recordTransition(em, { installationId: caller.installationId, guildId: caller.guildId,
      origin: { kind: 'user', userId: caller.actorId }, operation, occurredAt: at, references, outcome: 'succeeded',
      correlationId: caller.sourceRequestId, idempotencyKey: `${caller.sourceRequestId}:${operationKey}`,
      purgeAfter: new Date(at.getTime() + retentionDays * 86400_000) });
  }

  /** Persist an immutable transition idempotently; conflicting reuse of its operation identity is rejected. */
  async recordTransition(em: EntityManager, input: AuditEntryInput): Promise<string> {
    invariant(em.isInTransaction(), 'Audit writes require the owning transaction');
    invariant(/^[a-z][a-z0-9_.:-]{0,127}$/.test(input.operation), 'Invalid audit operation');
    invariant(input.correlationId.length <= 200 && input.idempotencyKey.length <= 200, 'Audit identity is too long');
    invariant(input.references.length <= 32, 'Too many audit references');
    invariant(['intent', 'succeeded', 'failed', 'unknown', 'canceled', 'discarded'].includes(input.outcome), 'Invalid audit outcome');
    const origin: AuditOrigin = input.origin.kind === 'user' ? { kind: 'user', userId: input.origin.userId }
      : input.origin.kind === 'policy' ? { kind: 'policy', policyRevisionId: input.origin.policyRevisionId }
        : { kind: 'system', component: input.origin.component };
    if (origin.kind === 'system') invariant(/^[a-z][a-z0-9_.:-]{0,127}$/.test(origin.component), 'Invalid audit component');
    const references = input.references.map(reference => {
      invariant(/^[a-z][a-z0-9_.:-]{0,63}$/.test(reference.owner), 'Invalid audit owner');
      return { owner: reference.owner, recordId: reference.recordId, revision: reference.revision };
    });
    const entry = new AuditEntry({ ...input, origin, references });
    // PostgreSQL uniqueness serializes competing replays without committing an independent success record.
    await em.execute(`insert into audit_entry
      (id,created_at,installation_id,guild_id,schema_version,occurred_at,origin,operation,"references",outcome,correlation_id,idempotency_key,purge_after)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict (installation_id,idempotency_key) do nothing`,
    [entry.id, entry.createdAt, entry.installationId, entry.guildId, entry.schemaVersion, entry.occurredAt,
      JSON.stringify(entry.origin), entry.operation, JSON.stringify(entry.references), entry.outcome,
      entry.correlationId, entry.idempotencyKey, entry.purgeAfter]);
    const stored = await em.findOneOrFail(AuditEntry, { installationId: entry.installationId, idempotencyKey: entry.idempotencyKey });
    const sameOrigin = stored.origin.kind === origin.kind && (origin.kind === 'user'
      ? stored.origin.kind === 'user' && stored.origin.userId === origin.userId
      : origin.kind === 'policy' ? stored.origin.kind === 'policy' && stored.origin.policyRevisionId === origin.policyRevisionId
        : stored.origin.kind === 'system' && stored.origin.component === origin.component);
    invariant(stored.guildId === entry.guildId && stored.operation === entry.operation && stored.outcome === entry.outcome
      && stored.correlationId === entry.correlationId && sameOrigin && stored.references.length === references.length
      && stored.references.every((reference, index) => reference.owner === references[index]!.owner
        && reference.recordId === references[index]!.recordId && reference.revision === references[index]!.revision), 'Audit replay payload mismatch');
    return stored.id;
  }

  /** Execution observations retain explicit unknown/failed outcomes and use the same transactional writer. */
  async recordExecutionOutcome(em: EntityManager, input: AuditEntryInput): Promise<string> {
    invariant(input.outcome !== 'intent', 'Execution outcome cannot be an intent');
    return this.recordTransition(em, input);
  }
}
