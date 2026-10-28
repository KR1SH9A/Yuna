/** Admit exact staff ban/unban/kick intent without model inference; durable dispatch is a separate owner workflow. */
import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertUuid, invariant } from '../../platform/db/entity-values.js';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { AuthorityService } from '../administration/authority.service.js';
import { SafetyService } from '../administration/safety.service.js';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import type { TrustedCallerContext } from '../administration/contracts.js';
import { ModerationAction, hashModerationOperation, type ModerationOperation, type StaffActionAuthority } from './entities/moderation-action.entity.js';
import { parseStaffSanction, type StaffSanctionResultDto } from './dto/staff-sanction.dto.js';
import type { ModerationActionOutcomeDto } from './dto/action-outcome.dto.js';

export class StaffModerationService {
  /** Native reads precede the shared installation/safety/grant locks; the audit joins the intent commit. */
  constructor(private readonly orm: MikroORM, private readonly scope: InstallationScope,
    private readonly authority: AuthorityService, private readonly safety: SafetyService,
    private readonly administration: GuildLifecycleService, private readonly audit = new AuditRecorder()) {}

  /** Only an explicit target/options DTO can request a ban; omitted history deletion is always zero. */
  async requestBan(caller: TrustedCallerContext, input: unknown): Promise<StaffSanctionResultDto> {
    return this.request(caller, input, 'ban');
  }

  /** Current native administrator status and the exact unban grant are checked again at later dispatch. */
  async requestUnban(caller: TrustedCallerContext, input: unknown): Promise<StaffSanctionResultDto> {
    return this.request(caller, input, 'unban');
  }

  /** Admit an explicit kick only for a current member under the caller's exact kick grant and native hierarchy. */
  async requestKick(caller: TrustedCallerContext, input: unknown): Promise<StaffSanctionResultDto> {
    return this.request(caller, input, 'kick');
  }

  /** Read-only exact-target authority permits outcome inspection even after a kick; it cannot authorize another effect. */
  async readActionStatus(trustedCaller: TrustedCallerContext, actionId: string): Promise<ModerationActionOutcomeDto> {
    assertUuid(actionId);
    const caller = Object.freeze({ ...trustedCaller });
    invariant(caller.guildId === this.scope.guildId && caller.installationId === this.scope.installationId, 'Installation mismatch');
    const initial = await this.orm.em.fork().findOneOrFail(ModerationAction, { ...this.scope, id: actionId });
    const operation = { capability: initial.kind === 'unban' ? 'moderation.unban' : initial.kind === 'kick' ? 'moderation.kick' : 'moderation.ban', targetUserId: initial.targetUserId } as const;
    const facts = await this.authority.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(async em => {
      const authorization = await this.authority.authorizeInTransaction(em, caller, operation, facts, 'status');
      invariant(authorization.allowed, authorization.allowed ? '' : authorization.reason);
      const action = await em.findOneOrFail(ModerationAction, { ...this.scope, id: actionId });
      return { actionId, kind: action.kind, state: action.state, unresolved: ['DISPATCHED', 'UNKNOWN'].includes(action.state),
        reasonCode: action.outcomeSummary?.code ?? null, ...(action.outcomeSummary?.discordMessageId ? { discordMessageId: action.outcomeSummary.discordMessageId } : {}),
        ...(action.outcomeSummary?.discordAuditEntryId ? { discordAuditEntryId: action.outcomeSummary.discordAuditEntryId } : {}) };
    });
  }

  /** Preserve one authenticated request identity and exact payload through retries without reporting external success. */
  private async request(trustedCaller: TrustedCallerContext, value: unknown, kind: 'ban' | 'unban' | 'kick'): Promise<StaffSanctionResultDto> {
    invariant(!this.orm.em.isInTransaction(), 'Staff orchestration must begin outside a transaction');
    const caller = Object.freeze({ ...trustedCaller }), input = parseStaffSanction(value, kind);
    invariant(caller.guildId === this.scope.guildId && caller.installationId === this.scope.installationId, 'Installation mismatch');
    const operation = { capability: kind === 'ban' ? 'moderation.ban' : kind === 'unban' ? 'moderation.unban' : 'moderation.kick', targetUserId: input.targetUserId } as const;
    const facts = await this.authority.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(async em => {
      const authorized = await this.authority.authorizeInTransaction(em, caller, operation, facts);
      invariant(authorized.allowed, authorized.allowed ? '' : authorized.reason);
      const gate = await this.safety.lockAndReadGate(em, this.scope);
      invariant(gate?.installationActive && !gate.paused, 'Moderation safety gate is closed');
      const payload: Exclude<ModerationOperation, { kind: 'warning' }> = kind === 'ban'
        ? { schemaVersion: 1, kind, reason: input.reason, deleteMessageSeconds: input.deleteMessageSeconds }
        : { schemaVersion: 1, kind, reason: input.reason };
      const payloadHash = hashModerationOperation(input.targetUserId, payload), deduplicationKey = `staff:${caller.sourceRequestId}`;
      const existing = await em.findOne(ModerationAction, { ...this.scope, deduplicationKey }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (existing) {
        invariant(existing.origin === 'staff' && existing.actorUserId === caller.actorId && existing.kind === kind
          && existing.targetUserId === input.targetUserId && existing.payloadHash === payloadHash, 'Sanction replay payload mismatch');
        return { status: 'accepted', actionId: existing.id, kind, state: existing.state };
      }
      const now = new Date(), policy = await this.administration.readPolicyConfig(em, this.scope);
      const authority: StaffActionAuthority = { origin: 'staff', actorUserId: caller.actorId, sourceRequestId: caller.sourceRequestId,
        grantBinding: { schemaVersion: 1, grantId: authorized.authority.grantId, revision: authorized.authority.grantRevision, operationHash: payloadHash } };
      const common = { ...this.scope, createdAt: now, targetUserId: input.targetUserId, deduplicationKey,
        auditCorrelation: caller.sourceRequestId.slice(0, 100), safetyRevision: gate.safetyRevision,
        purgeAfter: new Date(now.getTime() + policy.retention.payloadDays * 86_400_000) };
      const action = payload.kind !== 'unban' ? new ModerationAction({ ...common, authority, operationPayload: payload })
        : new ModerationAction({ ...common, operationPayload: payload, authority: { ...authority,
          adminUnbanRequest: { schemaVersion: 1, source: 'yuna', requestId: caller.sourceRequestId, actorUserId: caller.actorId,
            targetUserId: input.targetUserId, authorizationKind: 'discord_administrator', authorizedAt: facts.observedAt.toISOString() } } });
      em.persist(action);
      await this.audit.recordTransition(em, { ...this.scope, createdAt: now, occurredAt: now,
        origin: { kind: 'user', userId: caller.actorId }, operation: `moderation.${kind}`, outcome: 'intent',
        references: [{ owner: 'moderation', recordId: action.id, revision: action.rowRevision }],
        correlationId: action.id, idempotencyKey: `moderation-intent:${action.id}`,
        purgeAfter: new Date(now.getTime() + policy.retention.metadataDays * 86_400_000) });
      return { status: 'accepted', actionId: action.id, kind, state: action.state };
    });
  }
}
