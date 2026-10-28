/** Fence a confirmed installation removal, then resume bounded cleanup through each data owner's API. */
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { invariant } from '../../platform/db/entity-values.js';
import { defaultYunaPolicy, validatePolicyConfig } from '../../platform/config/policy-config.js';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { GuildInstallation, type CleanupProgress } from './entities/guild-installation.entity.js';
import { GuildSafetyState } from './entities/guild-safety-state.entity.js';
import { AuthorityService } from './authority.service.js';
import type { TrustedCallerContext } from './contracts.js';
import type { InstallationScope } from './guild-lifecycle.service.js';

export interface RemovalOwner {
  invalidate(em: EntityManager, at: Date): Promise<void>;
  cleanup(em: EntityManager, at: Date): Promise<Pick<CleanupProgress, 'disposition' | 'reasonCode'>>;
}

export class RemovalService {
  /** Owner callbacks join this transaction and never perform network I/O while its locks are held. */
  constructor(private readonly orm: MikroORM, private readonly scope: InstallationScope,
    private readonly authority: AuthorityService, private readonly owners: Readonly<Record<string, RemovalOwner>>,
    private readonly audit = new AuditRecorder()) {
    invariant(Object.keys(owners).length > 0 && Object.keys(owners).length <= 16, 'Removal requires bounded cleanup owners');
  }

  /** Only the current bootstrapped owner can remove the exact installation revision shown in status. */
  async beginRemoval(caller: TrustedCallerContext, expectedInstallationRevision: number): Promise<{ state: string; installationRevision: number }> {
    invariant(caller.installationId === this.scope.installationId && caller.guildId === this.scope.guildId, 'Installation mismatch');
    invariant(Number.isInteger(expectedInstallationRevision) && expectedInstallationRevision > 0, 'Invalid installation revision');
    const operation = { capability: 'administration.manage' } as const;
    const facts = await this.authority.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(async em => {
      const authorization = await this.authority.authorizeInTransaction(em, caller, operation, facts);
      invariant(authorization.allowed, authorization.allowed ? '' : authorization.reason);
      const installation = await em.findOneOrFail(GuildInstallation, { id: this.scope.installationId, guildId: this.scope.guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      invariant(installation.rowRevision === expectedInstallationRevision, 'Stale installation revision');
      const safety = await em.findOneOrFail(GuildSafetyState, this.scope, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const now = new Date();
      safety.pause(safety.safetyRevision, { kind: 'user', userId: caller.actorId }, 'installation_removal', now);
      installation.beginRemoval(Object.keys(this.owners).sort(), 'operator_confirmed', now);
      for (const owner of Object.values(this.owners)) await owner.invalidate(em, now);
      await this.audit.recordTransition(em, { ...this.scope, createdAt: now, occurredAt: now,
        origin: { kind: 'user', userId: caller.actorId }, operation: 'installation.remove', outcome: 'intent',
        references: [{ owner: 'administration', recordId: installation.id, revision: installation.rowRevision }],
        correlationId: caller.sourceRequestId, idempotencyKey: `remove:${caller.sourceRequestId}`,
        purgeAfter: new Date(now.getTime() + validatePolicyConfig(installation.operatorPolicy ?? defaultYunaPolicy).retention.metadataDays * 86400_000) });
      return { state: installation.state, installationRevision: installation.rowRevision };
    });
  }

  /** Retry interrupted cleanup; completion records every owner, including explicit retained-liability dispositions. */
  async runCleanup(): Promise<boolean> {
    return this.orm.em.fork().transactional(async em => {
      const installation = await em.findOneOrFail(GuildInstallation, { id: this.scope.installationId, guildId: this.scope.guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (installation.state !== 'removing') return false;
      await em.findOneOrFail(GuildSafetyState, this.scope, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const now = new Date();
      for (const name of installation.requiredCleanupOwners) {
        const prior = installation.cleanupProgress[name];
        if (prior && prior.disposition !== 'pending') continue;
        const owner = this.owners[name];
        invariant(owner, 'Captured cleanup owner is unavailable');
        const result = await owner.cleanup(em, now);
        installation.recordCleanupProgress(name, { ...result, recordedAt: now.toISOString(),
          nextAttemptAt: result.disposition === 'pending' ? new Date(now.getTime() + 60_000).toISOString() : null }, now);
      }
      if (installation.requiredCleanupOwners.some(name => installation.cleanupProgress[name]?.disposition === 'pending')) return false;
      installation.completeRemoval(now);
      await this.audit.recordTransition(em, { ...this.scope, createdAt: now, occurredAt: now,
        origin: { kind: 'system', component: 'administration' }, operation: 'installation.remove', outcome: 'succeeded',
        references: [{ owner: 'administration', recordId: installation.id, revision: installation.rowRevision }],
        correlationId: installation.id, idempotencyKey: `removal-completed:${installation.id}`,
        purgeAfter: new Date(now.getTime() + validatePolicyConfig(installation.operatorPolicy ?? defaultYunaPolicy).retention.metadataDays * 86400_000) });
      return true;
    });
  }
}
