/** Authorized pause/resume shares the existing installation/safety locks with admission and effect claims. */
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { assertDiscordId, assertUuid, invariant } from '../../platform/db/entity-values.js';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { GuildInstallation } from './entities/guild-installation.entity.js';
import { GuildSafetyState } from './entities/guild-safety-state.entity.js';
import { AuthorityService, type AdministrationInvalidator } from './authority.service.js';
import type { SafetyGate, TrustedCallerContext } from './contracts.js';
import { parsePauseGuildRequest, parseResumeGuildRequest, type GuildSafetyResponseDto } from './dto/guild-safety.dto.js';

export class SafetyService {
  /** Required invalidation participates in the same commit; optional governance is deliberately not composed. */
  constructor(private readonly orm: MikroORM, private readonly authority: AuthorityService,
    private readonly invalidate: AdministrationInvalidator, private readonly audit = new AuditRecorder()) {
    invariant(typeof invalidate === 'function', 'Safety invalidation is required');
  }

  /** A newly authorized pause advances the fence and cancels pending work without calling a model. */
  async pauseGuild(caller: TrustedCallerContext, value: unknown): Promise<GuildSafetyResponseDto> {
    const input = parsePauseGuildRequest(value);
    return this.change(caller, input.expectedSafetyRevision, input.reasonCode);
  }

  /** Resume only the reviewed current pause; advancing again keeps canceled/pre-pause work stale. */
  async resumeGuild(caller: TrustedCallerContext, value: unknown): Promise<GuildSafetyResponseDto> {
    const input = parseResumeGuildRequest(value);
    return this.change(caller, input.expectedSafetyRevision, null);
  }

  /** Join the caller's transaction and retain locks until its admission/dispatch claim commits. */
  async lockAndReadGate(em: EntityManager, scope: { installationId: string; guildId: string }): Promise<SafetyGate | null> {
    invariant(em.isInTransaction(), 'Safety checks require the caller transaction');
    assertUuid(scope.installationId); assertDiscordId(scope.guildId);
    const installation = await em.findOne(GuildInstallation, { id: scope.installationId, guildId: scope.guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!installation) return null;
    const safety = await em.findOne(GuildSafetyState, scope, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return safety ? { ...scope, paused: safety.paused, safetyRevision: safety.safetyRevision,
      installationActive: installation.state === 'active' && installation.discordAvailability === 'available' } : null;
  }

  /** Current native facts are read before locks; all local validation and invalidation share one transaction. */
  private async change(trustedCaller: TrustedCallerContext, expectedRevision: number, reasonCode: string | null): Promise<GuildSafetyResponseDto> {
    const caller = Object.freeze({ ...trustedCaller });
    const operation = { capability: reasonCode === null ? 'guild.resume' : 'guild.pause' } as const;
    const facts = await this.authority.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(async em => {
      const evaluation = await this.authority.authorizeInTransaction(em, caller, operation, facts);
      invariant(evaluation.allowed, evaluation.allowed ? '' : evaluation.reason);
      const scope = { installationId: caller.installationId, guildId: caller.guildId };
      const safety = await em.findOneOrFail(GuildSafetyState, scope, { lockMode: LockMode.PESSIMISTIC_WRITE });
      invariant(safety.safetyRevision === expectedRevision, 'Stale safety revision');
      const now = new Date(), actor = { kind: 'user', userId: caller.actorId } as const;
      if (reasonCode === null) safety.resume(expectedRevision, actor, now);
      else safety.pause(expectedRevision, actor, reasonCode, now);
      await this.invalidate(em, { ...scope, kind: reasonCode === null ? 'guild_resumed' : 'guild_paused', safetyRevision: safety.safetyRevision, at: now });
      const installation = await em.findOneOrFail(GuildInstallation, { id: caller.installationId, guildId: caller.guildId });
      const retention = installation.operatorPolicy?.retention;
      const days = retention && typeof retention === 'object' && !Array.isArray(retention) && typeof retention.metadataDays === 'number'
        ? retention.metadataDays : 7;
      await this.audit.recordControlChange(em, caller, reasonCode === null ? 'administration.resume' : 'administration.pause',
        [{ owner: 'administration', recordId: safety.id, revision: safety.safetyRevision }], now, days);
      return { paused: safety.paused, safetyRevision: safety.safetyRevision, reasonCode: safety.reasonCode };
    });
  }
}
