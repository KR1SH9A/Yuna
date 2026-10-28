/** Own installation identity, feature admission, and the locks used by privacy cleanup. */
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { GuildInstallation } from './entities/guild-installation.entity.js';
import { GuildSafetyState } from './entities/guild-safety-state.entity.js';
import { createConversationUsagePolicy } from '../../platform/usage/conversation-usage.js';
import { assertDiscordId } from '../../platform/db/entity-values.js';
import { defaultYunaPolicy, validatePolicyConfig, type YunaPolicyConfig } from '../../platform/config/policy-config.js';

export interface InstallationScope { installationId: string; guildId: string }

/** Administration owns installation/safety gates; other owners receive only scoped facts. */
export class GuildLifecycleService {
  /** Retain the shared ORM; every public operation creates or joins an explicit local transaction. */
  constructor(private readonly orm: MikroORM) {}

  /** Privacy withdrawal and deletion remain available while paused, disabled or removing; this does not grant feature admission. */
  async lockPrivacy(em: EntityManager, scope: InstallationScope): Promise<InstallationScope> {
    if (!em.isInTransaction()) throw new Error('Privacy changes require the caller transaction');
    const installation = await em.findOneOrFail(GuildInstallation, { id: scope.installationId, guildId: scope.guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    await em.findOneOrFail(GuildSafetyState, scope, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return { installationId: installation.id, guildId: installation.guildId };
  }

  /** Feature owners read approved retention/settings through Administration inside their admission transaction. */
  async readPolicyConfig(em: EntityManager, scope: InstallationScope): Promise<YunaPolicyConfig> {
    if (!em.isInTransaction()) throw new Error('Policy reads require the caller transaction');
    const installation = await em.findOneOrFail(GuildInstallation, { id: scope.installationId, guildId: scope.guildId });
    return validatePolicyConfig(installation.operatorPolicy ?? defaultYunaPolicy);
  }

  /** Explicitly configured single-server installation; concurrent starts share one generation. */
  async registerGuild(guildId: string, model: string, options: { resumeRemoval?: boolean } = {}): Promise<InstallationScope> {
    assertDiscordId(guildId);
    return this.orm.em.fork().transactional(async em => {
      await em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`installation:${guildId}`]);
      const now = new Date();
      let installation = await em.findOne(GuildInstallation, { guildId, state: { $in: ['active', 'suspended'] } }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!installation) {
        const prior = await em.findOne(GuildInstallation, { guildId }, { orderBy: { generation: 'desc' } });
        if (prior?.state === 'removing') {
          if (options.resumeRemoval) return { installationId: prior.id, guildId };
          throw new Error('Guild removal is still in progress');
        }
        installation = new GuildInstallation({ guildId, generation: (prior?.generation ?? -1) + 1, registeredAt: now, createdAt: now, featureAdmission: { community: 'enabled', moderation: 'disabled', memory: 'disabled', debates: 'disabled' } });
        em.persist(installation);
        const scope = { installationId: installation.id, guildId };
        em.persist(new GuildSafetyState({ ...scope, createdAt: now, changedAt: now, changedBy: { kind: 'system', operation: 'server-test-install' } }));
        em.persist(createConversationUsagePolicy(scope, now, model, 20));
      } else {
        // Restart creates a gap in observed edits/deletes. Fence old task disclosures first.
        const safety = await em.findOneOrFail(GuildSafetyState, { installationId: installation.id, guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        const actor = { kind: 'system', operation: 'gateway-restart' } as const;
        if (safety.paused) safety.pause(safety.safetyRevision, actor, safety.reasonCode, now);
        else safety.resume(safety.safetyRevision, actor, now);
      }
      installation.recordAvailability('available', now);
      return { installationId: installation.id, guildId };
    });
  }

  /** Caller transaction lock order: installation, safety, then source/request/task rows. */
  async lockAdmission(em: EntityManager, scope: InstallationScope, purpose: 'admission' | 'continuation' = 'admission'): Promise<{ safetyRevision: number } | null> {
    return this.lockFeatureAdmission(em, scope, 'community', purpose);
  }

  /** Draining permits already-admitted work while every feature retains its independent admission gate. */
  async lockFeatureAdmission(em: EntityManager, scope: InstallationScope, feature: 'community' | 'moderation' | 'memory' | 'debates',
    purpose: 'admission' | 'continuation' = 'admission'): Promise<{ safetyRevision: number } | null> {
    const installation = await em.findOne(GuildInstallation, { id: scope.installationId, guildId: scope.guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!installation || installation.state !== 'active' || installation.discordAvailability !== 'available') return null;
    const admission = installation.featureAdmission[feature];
    if (admission !== 'enabled' && !(purpose === 'continuation' && admission === 'read_only')) return null;
    const safety = await em.findOne(GuildSafetyState, scope, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return !safety || safety.paused ? null : { safetyRevision: safety.safetyRevision };
  }

  /** Gateway availability is not installation/removal authority. Preserve the same identity. */
  async recordAvailability(scope: InstallationScope, available: boolean): Promise<void> {
    await this.orm.em.fork().transactional(async em => {
      const installation = await em.findOneOrFail(GuildInstallation, { id: scope.installationId, guildId: scope.guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const now = new Date();
      if (!available && installation.discordAvailability === 'available') {
        const safety = await em.findOneOrFail(GuildSafetyState, scope, { lockMode: LockMode.PESSIMISTIC_WRITE });
        const actor = { kind: 'system', operation: 'gateway-unavailable' } as const;
        if (safety.paused) safety.pause(safety.safetyRevision, actor, safety.reasonCode, now);
        else safety.resume(safety.safetyRevision, actor, now);
      }
      installation.recordAvailability(available ? 'available' : 'unavailable', now);
    });
  }
}
