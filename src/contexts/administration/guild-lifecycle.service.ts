import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { GuildInstallation } from './entities/guild-installation.entity.js';
import { GuildSafetyState } from './entities/guild-safety-state.entity.js';
import { createConversationUsagePolicy } from '../../platform/usage/conversation-usage.js';
import { assertDiscordId } from '../../platform/db/entity-values.js';

export interface InstallationScope { installationId: string; guildId: string }

/** Administration owns installation/safety gates; other owners receive only scoped facts. */
export class GuildLifecycleService {
  constructor(private readonly orm: MikroORM) {}

  /** Explicitly configured single-server installation; concurrent starts share one generation. */
  async registerGuild(guildId: string, model: string): Promise<InstallationScope> {
    assertDiscordId(guildId);
    return this.orm.em.fork().transactional(async em => {
      await em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`installation:${guildId}`]);
      const now = new Date();
      let installation = await em.findOne(GuildInstallation, { guildId, state: { $in: ['active', 'suspended'] } }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!installation) {
        const prior = await em.findOne(GuildInstallation, { guildId }, { orderBy: { generation: 'desc' } });
        if (prior?.state === 'removing') throw new Error('Guild removal is still in progress');
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
  async lockAdmission(em: EntityManager, scope: InstallationScope): Promise<{ safetyRevision: number } | null> {
    const installation = await em.findOne(GuildInstallation, { id: scope.installationId, guildId: scope.guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!installation || installation.state !== 'active' || installation.discordAvailability !== 'available' || installation.featureAdmission.community !== 'enabled') return null;
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
