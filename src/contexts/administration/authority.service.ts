/** Administration owns owner bootstrap and scoped grants. Discord reads precede short, installation-serialized transactions. */
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { assertDiscordId, assertUuid, copyJson, invariant } from '../../platform/db/entity-values.js';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { CapabilityGrant } from './entities/capability-grant.entity.js';
import { GuildInstallation } from './entities/guild-installation.entity.js';
import { GuildSafetyState } from './entities/guild-safety-state.entity.js';
import { AuthorityPolicy } from './authority.policy.js';
import { administrationCapabilities, type AdministrationFactReader, type AdministrationInvalidation, type AuthorityEvaluation,
  type AuthorityOperation, type CurrentNativeFacts, type StaffRequestAuthority, type TrustedCallerContext } from './contracts.js';
import { parseGrantCapabilityRequest, parseRevokeGrantRequest, type CapabilityGrantResponseDto } from './dto/grant-revocation.dto.js';

/** This mandatory hook performs local owner invalidation only; failure rolls back the authorization change. */
export type AdministrationInvalidator = (em: EntityManager, event: AdministrationInvalidation) => Promise<void>;

/** Optional composition boundary: supplied facts must have been read before this active owner transaction. */
export interface AuthorityTransactionContext { readonly em: EntityManager; readonly facts: CurrentNativeFacts }

export class AuthorityService {
  private readonly policy = new AuthorityPolicy();

  /** Dependencies are explicit; an omitted invalidation path must not silently become a no-op. */
  constructor(private readonly orm: MikroORM, private readonly factReader: AdministrationFactReader,
    private readonly invalidate: AdministrationInvalidator, private readonly audit = new AuditRecorder()) {
    invariant(typeof invalidate === 'function', 'Administration invalidation is required');
  }

  /** Verify the current guild owner, then create one baseline grant per owner/installation without staged enrollment. */
  async bootstrapOwner(trustedCaller: TrustedCallerContext): Promise<CapabilityGrantResponseDto> {
    const caller = this.bindCaller(trustedCaller);
    const operation = { capability: 'administration.manage' } as const;
    const facts = await this.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(async em => {
      const installation = await this.lockInstallation(em, caller);
      invariant(installation !== null, 'Installation is unavailable');
      const reason = this.policy.canExecute(caller, operation, facts, new Date());
      invariant(reason === null, reason ?? 'Owner verification failed');
      const identity = { installationId: caller.installationId, guildId: caller.guildId,
        sourceRequestId: `owner-bootstrap:${caller.actorId}`, sourceOperationKey: 'baseline-owner' };
      const existing = await em.findOne(CapabilityGrant, identity, { lockMode: LockMode.PESSIMISTIC_WRITE });
      // A revoked baseline is never silently recreated by replaying installation setup.
      if (existing) return this.view(existing);
      const now = new Date();
      const grant = new CapabilityGrant({ ...identity, grantee: { kind: 'user', userId: caller.actorId },
        grantor: { kind: 'user', userId: caller.actorId }, capability: 'administration.manage',
        scope: { channelIds: [], targetUserIds: [] }, grantedAt: now, expiresAt: null, createdAt: now });
      em.persist(grant);
      await this.auditGrant(em, caller, 'administration.owner_bootstrap', grant, now);
      return this.view(grant);
    });
  }

  /** Only the current bootstrapped owner can issue exact, immutable grants; replay must match the original payload. */
  async grantCapability(trustedCaller: TrustedCallerContext, value: unknown, transaction?: AuthorityTransactionContext): Promise<CapabilityGrantResponseDto> {
    const caller = this.bindCaller(trustedCaller);
    const input = parseGrantCapabilityRequest(value);
    const operation = { capability: 'administration.manage' } as const;
    invariant(!transaction || transaction.em.isInTransaction(), 'Authority mutation requires the owner transaction');
    const facts = transaction?.facts ?? await this.readCurrentFacts(caller, operation);
    /** Apply this exact mutation under the existing owner transaction and current authority locks. */
    const apply = async (em: EntityManager): Promise<CapabilityGrantResponseDto> => {
      const evaluation = await this.authorizeInTransaction(em, caller, operation, facts);
      invariant(evaluation.allowed, evaluation.allowed ? '' : evaluation.reason);
      const identity = { installationId: caller.installationId, guildId: caller.guildId,
        sourceRequestId: caller.sourceRequestId, sourceOperationKey: input.sourceOperationKey };
      const existing = await em.findOne(CapabilityGrant, identity, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (existing) {
        invariant(existing.grantor.userId === caller.actorId && existing.grantee.userId === input.granteeUserId
          && existing.capability === input.capability && JSON.stringify(existing.scope) === JSON.stringify(input.scope)
          && (existing.expiresAt?.toISOString() ?? null) === input.expiresAt, 'Grant replay payload mismatch');
        return this.view(existing);
      }
      const now = new Date();
      const grant = new CapabilityGrant({ ...identity, grantee: { kind: 'user', userId: input.granteeUserId },
        grantor: { kind: 'user', userId: caller.actorId }, capability: input.capability, scope: input.scope,
        grantedAt: now, expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt), createdAt: now });
      em.persist(grant);
      await this.auditGrant(em, caller, 'administration.grant', grant, now);
      return this.view(grant);
    };
    return transaction ? apply(transaction.em) : this.orm.em.fork().transactional(apply);
  }

  /** Revoke under expected revisions, advance the shared disclosure fence and invalidate pending owner work atomically. */
  async revokeGrant(trustedCaller: TrustedCallerContext, value: unknown, transaction?: AuthorityTransactionContext): Promise<CapabilityGrantResponseDto> {
    const caller = this.bindCaller(trustedCaller);
    const input = parseRevokeGrantRequest(value);
    const operation = { capability: 'administration.manage' } as const;
    invariant(!transaction || transaction.em.isInTransaction(), 'Authority mutation requires the owner transaction');
    const facts = transaction?.facts ?? await this.readCurrentFacts(caller, operation);
    /** Apply this exact mutation under the existing owner transaction and current authority locks. */
    const apply = async (em: EntityManager): Promise<CapabilityGrantResponseDto> => {
      const evaluation = await this.authorizeInTransaction(em, caller, operation, facts);
      invariant(evaluation.allowed, evaluation.allowed ? '' : evaluation.reason);
      const scope = { installationId: caller.installationId, guildId: caller.guildId };
      const grant = await em.findOne(CapabilityGrant, { ...scope, id: input.grantId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      invariant(grant !== null, 'Grant not found in installation');
      if (grant.revokedAt && grant.authorityRevision === input.expectedAuthorityRevision + 1
        && grant.rowRevision === input.expectedRowRevision + 1 && grant.revocationReason === input.reasonCode) return this.view(grant);
      invariant(grant.authorityRevision === input.expectedAuthorityRevision && grant.rowRevision === input.expectedRowRevision, 'Stale grant revision');
      if (grant.revokedAt) return this.view(grant);
      const now = new Date();
      grant.revoke(input.expectedAuthorityRevision, input.reasonCode, now);
      const safety = await em.findOneOrFail(GuildSafetyState, scope, { lockMode: LockMode.PESSIMISTIC_WRITE });
      // A global revision fence is conservative: scoped revocation cannot leave disclosed work usable.
      if (safety.paused) safety.pause(safety.safetyRevision, { kind: 'user', userId: caller.actorId }, safety.reasonCode, now);
      else safety.resume(safety.safetyRevision, { kind: 'user', userId: caller.actorId }, now);
      await this.invalidate(em, { ...scope, kind: 'grant_revoked', grantId: grant.id,
        previousGrantRevision: input.expectedAuthorityRevision, safetyRevision: safety.safetyRevision, at: now });
      await this.auditGrant(em, caller, 'administration.revoke', grant, now);
      return this.view(grant);
    };
    return transaction ? apply(transaction.em) : this.orm.em.fork().transactional(apply);
  }

  /** Fetch facts outside database transactions; the locked evaluation rechecks their freshness after lock waits. */
  async evaluateStaffRequest(trustedCaller: TrustedCallerContext, requestedOperation: AuthorityOperation): Promise<AuthorityEvaluation> {
    const caller = this.bindCaller(trustedCaller), operation = this.bindOperation(requestedOperation);
    const facts = await this.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(em => this.authorizeInTransaction(em, caller, operation, facts));
  }

  /** Read a fresh, exact native observation. Callers must not invoke this orchestration method inside an ORM transaction. */
  async readCurrentFacts(trustedCaller: TrustedCallerContext, requestedOperation: AuthorityOperation): Promise<CurrentNativeFacts> {
    invariant(!this.orm.em.isInTransaction(), 'Native reads must run outside transactions');
    const caller = this.bindCaller(trustedCaller), operation = this.bindOperation(requestedOperation);
    const facts = await this.factReader.readFacts(caller, operation);
    // Copy the adapter result so concurrent cache updates cannot rewrite a previously observed authorization.
    return { guildId: facts.guildId, actorId: facts.actorId, sourceRequestId: facts.sourceRequestId,
      operation: { ...facts.operation }, observedAt: new Date(facts.observedAt), complete: facts.complete,
      ownerId: facts.ownerId, actorIsMember: facts.actorIsMember, actorPermissions: facts.actorPermissions,
      botPermissions: facts.botPermissions, ...(facts.target ? { target: { ...facts.target } } : {}) };
  }

  /** Lock installation → safety → grants and evaluate exact scope. This joins the owner's active transaction. */
  async authorizeInTransaction(em: EntityManager, caller: TrustedCallerContext, operation: AuthorityOperation,
    facts: CurrentNativeFacts, purpose: 'operation' | 'status' = 'operation'): Promise<AuthorityEvaluation> {
    invariant(em.isInTransaction(), 'Authority checks require the caller transaction');
    caller = this.bindCaller(caller); operation = this.bindOperation(operation);
    // Read-only settings and exact moderation status inspection cannot authorize a new effect.
    const statusOperation = operation.targetUserId === undefined
      && ((operation.capability === 'guild.configure' && operation.channelId === undefined)
        || (operation.capability === 'community.configure' && operation.channelId !== undefined))
      || (operation.targetUserId !== undefined && operation.channelId === undefined
        && ['moderation.ban', 'moderation.unban', 'moderation.kick'].includes(operation.capability));
    invariant(purpose !== 'status' || statusOperation, 'Status authorization is read-only management');
    const installation = await this.lockInstallation(em, caller, purpose);
    if (!installation) return { allowed: false, reason: 'installation_unavailable' };
    const scope = { installationId: caller.installationId, guildId: caller.guildId };
    const safety = await em.findOne(GuildSafetyState, scope, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!safety) return { allowed: false, reason: 'safety_gate_missing' };
    const grants = await em.find(CapabilityGrant, { ...scope, grantee: { userId: caller.actorId }, revokedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } });
    const now = new Date();
    const reason = this.policy.canExecute(caller, operation, facts, now, purpose);
    if (reason) return { allowed: false, reason };
    const grant = grants.find(candidate => candidate.isCurrentFor({ userId: caller.actorId, ...operation, at: now }))
      ?? (!operation.capability.startsWith('moderation.') && caller.actorId === facts.ownerId
        ? grants.find(candidate => candidate.isCurrentFor({ userId: caller.actorId, capability: 'administration.manage', at: now })) : undefined);
    if (!grant) return { allowed: false, reason: 'application_grant_required' };
    return { allowed: true, authority: { purpose, caller, operation, grantId: grant.id, grantRevision: grant.authorityRevision,
      grantRowRevision: grant.rowRevision, installationGeneration: installation.generation, installationRevision: installation.rowRevision,
      safetyRevision: safety.safetyRevision, observedAt: new Date(facts.observedAt) } };
  }

  /** Recheck the original exact grant and operation under current native facts; a replacement grant cannot revive old work. */
  async validateGrantRevision(em: EntityManager, binding: StaffRequestAuthority, facts: CurrentNativeFacts): Promise<boolean> {
    if (binding.purpose !== 'operation') return false;
    const current = await this.authorizeInTransaction(em, binding.caller, binding.operation, facts);
    return current.allowed && current.authority.grantId === binding.grantId
      && current.authority.grantRevision === binding.grantRevision && current.authority.grantRowRevision === binding.grantRowRevision
      && current.authority.installationGeneration === binding.installationGeneration
      && current.authority.installationRevision === binding.installationRevision && current.authority.safetyRevision === binding.safetyRevision;
  }

  /** Serialize all authority changes with existing admission, removal and availability gates. */
  private async lockInstallation(em: EntityManager, caller: TrustedCallerContext, purpose: 'operation' | 'status' = 'operation'): Promise<GuildInstallation | null> {
    const installation = await em.findOne(GuildInstallation, { id: caller.installationId, guildId: caller.guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return installation && (purpose === 'status' || (installation.state === 'active' && installation.discordAvailability === 'available')) ? installation : null;
  }

  /** Validate and detach trusted transport identity, without confusing it with proof of permission. */
  private bindCaller(caller: TrustedCallerContext): TrustedCallerContext {
    assertDiscordId(caller.actorId); assertDiscordId(caller.guildId); assertUuid(caller.installationId);
    invariant(typeof caller.sourceRequestId === 'string' && caller.sourceRequestId.length > 0 && caller.sourceRequestId.length <= 200, 'Invalid source request identity');
    return Object.freeze({ actorId: caller.actorId, guildId: caller.guildId, installationId: caller.installationId, sourceRequestId: caller.sourceRequestId });
  }

  /** Restrict capability names and operation references before facts are requested or compared. */
  private bindOperation(operation: AuthorityOperation): AuthorityOperation {
    invariant(administrationCapabilities.includes(operation.capability), 'Unknown capability');
    if (operation.channelId !== undefined) assertDiscordId(operation.channelId);
    if (operation.targetUserId !== undefined) assertDiscordId(operation.targetUserId);
    return Object.freeze({ capability: operation.capability, ...(operation.channelId ? { channelId: operation.channelId } : {}),
      ...(operation.targetUserId ? { targetUserId: operation.targetUserId } : {}) });
  }

  /** Return a detached, bounded display snapshot rather than an ORM entity or reusable authority. */
  private view(grant: CapabilityGrant): CapabilityGrantResponseDto {
    return { grantId: grant.id, granteeUserId: grant.grantee.userId, capability: grant.capability, scope: copyJson(grant.scope),
      expiresAt: grant.expiresAt?.toISOString() ?? null, revoked: grant.revokedAt !== null,
      authorityRevision: grant.authorityRevision, rowRevision: grant.rowRevision };
  }

  /** Grant history records only trusted identity and revisions under the currently approved metadata retention. */
  private async auditGrant(em: EntityManager, caller: TrustedCallerContext, operation: string, grant: CapabilityGrant, at: Date): Promise<void> {
    const installation = await em.findOneOrFail(GuildInstallation, { id: caller.installationId, guildId: caller.guildId });
    const retention = installation.operatorPolicy?.retention;
    const days = retention && typeof retention === 'object' && !Array.isArray(retention) && typeof retention.metadataDays === 'number'
      ? retention.metadataDays : 7;
    await this.audit.recordControlChange(em, caller, operation,
      [{ owner: 'administration', recordId: grant.id, revision: grant.authorityRevision }], at, days,
      `${operation}:${grant.sourceOperationKey}`);
  }
}
