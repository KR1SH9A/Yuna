/** Authorize operator settings and status while each feature retains its own records and cleanup operations. */
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { isDeepStrictEqual } from 'node:util';
import { assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type JsonObject } from '../../platform/db/entity-values.js';
import { validatePolicyConfig, type YunaPolicyConfig } from '../../platform/config/policy-config.js';
import { createConversationUsagePolicy } from '../../platform/usage/conversation-usage.js';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { AuthorityService } from './authority.service.js';
import type { TrustedCallerContext } from './contracts.js';
import { GuildInstallation, type FeatureAdmission, type InstallationState, type CleanupProgress } from './entities/guild-installation.entity.js';
import { GuildSafetyState } from './entities/guild-safety-state.entity.js';
import { UsagePolicy } from './entities/usage-policy.entity.js';
import { CapabilityGrant } from './entities/capability-grant.entity.js';

export interface ChannelSettingsChange { channelId: string; mode: 'silent' | 'direct'; expectedRowRevision: number | null }
export interface ChannelSettingsView { channelId: string; mode: 'silent' | 'direct'; rowRevision: number }
export interface ChannelSettingsSnapshot { channelId: string; mode: 'silent' | 'direct' | 'proactive'; rowRevision: number }
export interface CommunityOperationalStatus { pendingRequests: number; readyDeliveries: number; unknownDeliveries: number }
/** Composition supplies feature-owned local functions, never entities or direct table access. */
export interface ConfigurationOwners {
  readonly availableFeatures?: readonly ('memory' | 'debates')[];
  readChannelSettings?(em: EntityManager, channelId: string): Promise<ChannelSettingsSnapshot>;
  updateChannelSettings(em: EntityManager, input: ChannelSettingsChange, at: Date): Promise<ChannelSettingsView>;
  readOperationalStatus(em: EntityManager): Promise<CommunityOperationalStatus>;
  invalidatePending(em: EntityManager, reason: string, at: Date, channelId?: string): Promise<void>;
  publishModerationPolicy?(em: EntityManager, caller: TrustedCallerContext, config: YunaPolicyConfig, at: Date): Promise<{ policyRevisionId: string | null; changed: boolean }>;
}
export interface OperatorStatus extends CommunityOperationalStatus {
  installationId: string;
  installationState: InstallationState;
  cleanupProgress: Readonly<Record<string, CleanupProgress>>;
  installationRevision: number;
  policyRevision: number;
  usagePolicyRevision: number | null;
  paused: boolean;
  safetyRevision: number;
  featureAdmission: FeatureAdmission;
  grants: { grantId: string; granteeUserId: string; capability: string; authorityRevision: number; rowRevision: number; revoked: boolean; expiresAt: string | null }[];
}
export interface ConfigurationResult { policyRevision: number; usagePolicyRevision: number; changed: boolean }

export class ConfigurationService {
  /** Owners must support invalidation before any configuration-changing command is composed. */
  constructor(private readonly orm: MikroORM, private readonly authority: AuthorityService, private readonly model: string,
    private readonly owners: ConfigurationOwners, private readonly audit = new AuditRecorder()) {
    invariant(typeof owners.invalidatePending === 'function', 'Configuration invalidation is required');
  }

  /** Startup can hold new conversations until the configured file exactly matches an approved persisted policy. */
  async isConfigurationCurrent(scope: { installationId: string; guildId: string }, value: unknown): Promise<boolean> {
    assertUuid(scope.installationId); assertDiscordId(scope.guildId);
    const config = validatePolicyConfig(value);
    const installation = await this.orm.em.fork().findOne(GuildInstallation, { id: scope.installationId, guildId: scope.guildId });
    return installation !== null && isDeepStrictEqual(installation.operatorPolicy, config);
  }

  /** Return only IDs, revisions and aggregate counts after current operator authorization. */
  async status(trustedCaller: TrustedCallerContext): Promise<OperatorStatus> {
    const caller = Object.freeze({ ...trustedCaller }), operation = { capability: 'guild.configure' } as const;
    const facts = await this.authority.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(async em => {
      const permission = await this.authority.authorizeInTransaction(em, caller, operation, facts, 'status');
      invariant(permission.allowed, permission.allowed ? '' : permission.reason);
      const scope = { installationId: caller.installationId, guildId: caller.guildId };
      const installation = await em.findOneOrFail(GuildInstallation, { id: caller.installationId, guildId: caller.guildId });
      const safety = await em.findOneOrFail(GuildSafetyState, scope);
      const usage = await em.findOne(UsagePolicy, scope);
      const grants = await em.find(CapabilityGrant, scope, { limit: 50, orderBy: { createdAt: 'desc', id: 'asc' } });
      return { ...await this.owners.readOperationalStatus(em), installationId: installation.id,
        installationState: installation.state, cleanupProgress: copyJson(installation.cleanupProgress),
        installationRevision: installation.rowRevision, policyRevision: installation.policyRevision,
        usagePolicyRevision: usage?.policyRevision ?? null, paused: safety.paused, safetyRevision: safety.safetyRevision,
        featureAdmission: copyJson(installation.featureAdmission), grants: grants.map(grant => ({ grantId: grant.id,
          granteeUserId: grant.grantee.userId, capability: grant.capability, authorityRevision: grant.authorityRevision,
          rowRevision: grant.rowRevision, revoked: grant.revokedAt !== null, expiresAt: grant.expiresAt?.toISOString() ?? null })) };
    });
  }

  /** Reveal only one channel's mode and revision after fresh native permission and exact application-scope checks. */
  async readChannelSettings(trustedCaller: TrustedCallerContext, input: { channelId: string }): Promise<ChannelSettingsSnapshot> {
    const caller = Object.freeze({ ...trustedCaller });
    invariant(input !== null && typeof input === 'object' && Object.keys(input).every(key => key === 'channelId'), 'Invalid channel status request');
    assertDiscordId(input.channelId);
    const channelId = input.channelId, operation = { capability: 'community.configure', channelId } as const;
    invariant(this.owners.readChannelSettings, 'Channel settings inspection is unavailable');
    const facts = await this.authority.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(async em => {
      const permission = await this.authority.authorizeInTransaction(em, caller, operation, facts, 'status');
      invariant(permission.allowed, permission.allowed ? '' : permission.reason);
      const result = await this.owners.readChannelSettings!(em, channelId);
      return { channelId: result.channelId, mode: result.mode, rowRevision: result.rowRevision };
    });
  }

  /** Authorize an exact channel scope, then delegate revision checking and cancellation to Community. */
  async updateChannelSettings(trustedCaller: TrustedCallerContext, input: ChannelSettingsChange): Promise<ChannelSettingsView> {
    const caller = Object.freeze({ ...trustedCaller });
    invariant(input !== null && typeof input === 'object' && Object.keys(input).every(key => ['channelId', 'mode', 'expectedRowRevision'].includes(key)), 'Invalid channel settings request');
    assertDiscordId(input.channelId);
    invariant(input.mode === 'silent' || input.mode === 'direct', 'Unsupported channel mode');
    if (input.expectedRowRevision !== null) assertNonNegativeInteger(input.expectedRowRevision, 'expectedRowRevision');
    // Discord uses revision zero to refer to a channel with no settings yet.
    const change = Object.freeze({ channelId: input.channelId, mode: input.mode, expectedRowRevision: input.expectedRowRevision === 0 ? null : input.expectedRowRevision });
    const operation = { capability: 'community.configure', channelId: change.channelId } as const;
    const facts = await this.authority.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(async em => {
      const permission = await this.authority.authorizeInTransaction(em, caller, operation, facts);
      invariant(permission.allowed, permission.allowed ? '' : permission.reason);
      const now = new Date();
      const result = await this.owners.updateChannelSettings(em, change, now);
      await this.recordChange(em, caller, 'community.channel_settings', now, result.rowRevision);
      return { channelId: result.channelId, mode: result.mode, rowRevision: result.rowRevision };
    });
  }

  /** Persist a validated operator file and usage policy together; file contents alone never grant authority. */
  async applyConfiguration(trustedCaller: TrustedCallerContext, value: unknown, expectedPolicyRevision: number): Promise<ConfigurationResult> {
    const caller = Object.freeze({ ...trustedCaller });
    assertNonNegativeInteger(expectedPolicyRevision, 'expectedPolicyRevision');
    const config = validatePolicyConfig(value);
    invariant((!config.moderation.enabled && config.moderation.policy === null) || this.owners.publishModerationPolicy, 'Moderation configuration is not supported by this deployment');
    for (const feature of ['memory', 'debates'] as const) invariant(config.features?.[feature] !== true
      || this.owners.availableFeatures?.includes(feature), `${feature} is not supported by this deployment`);
    const operation = { capability: 'guild.configure' } as const;
    const facts = await this.authority.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(async em => {
      const permission = await this.authority.authorizeInTransaction(em, caller, operation, facts);
      invariant(permission.allowed, permission.allowed ? '' : permission.reason);
      const scope = { installationId: caller.installationId, guildId: caller.guildId };
      const installation = await em.findOneOrFail(GuildInstallation, { id: scope.installationId, guildId: scope.guildId });
      let usage = await em.findOne(UsagePolicy, scope);
      if (isDeepStrictEqual(installation.operatorPolicy, config)) {
        invariant(usage !== null, 'Configured installation is missing its usage policy');
        return { policyRevision: installation.policyRevision, usagePolicyRevision: usage.policyRevision, changed: false };
      }
      invariant(installation.policyRevision === expectedPolicyRevision, 'Stale operator policy revision');
      const now = new Date();
      // First invalidate existing tasks under their owner locks; usage/budget rows come last in lock order.
      await this.owners.invalidatePending(em, 'operator_configuration_changed', now);
      const moderation = await this.owners.publishModerationPolicy?.(em, caller, config, now);
      if (config.moderation.enabled) invariant(moderation?.policyRevisionId, 'Enabled moderation requires a published policy');
      usage = await em.findOne(UsagePolicy, scope, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
      const template = createConversationUsagePolicy(scope, now, this.model, config.usage.dailyAttemptLimit, config.usage);
      if (usage) usage.revise({ schemaVersion: 1, limits: template.limits, windowRules: template.windowRules,
        perAttemptBounds: template.perAttemptBounds }, usage.policyRevision, { kind: 'user', userId: caller.actorId }, now);
      else { usage = template; usage.updatedBy = { kind: 'user', userId: caller.actorId }; em.persist(usage); }
      installation.updateOperatorPolicy(expectedPolicyRevision, config as unknown as JsonObject, now);
      installation.updateFeatureAdmission(installation.rowRevision, { ...installation.featureAdmission,
        moderation: config.moderation.enabled ? 'enabled' : 'disabled',
        memory: config.features?.memory === true ? 'enabled' : 'disabled',
        debates: config.features?.debates === true ? 'enabled' : 'disabled' }, now);
      await this.advanceSafety(em, caller, now);
      await this.recordChange(em, caller, 'administration.configure', now, installation.policyRevision, config.retention.metadataDays);
      return { policyRevision: installation.policyRevision, usagePolicyRevision: usage.policyRevision, changed: true };
    });
  }

  /** Disabling Community explicitly chooses drain or cancel; drain preserves the old work's safety bindings. */
  async setFeatureAdmission(trustedCaller: TrustedCallerContext, input: {
    feature: 'community'; enabled: boolean; disposition: 'drain' | 'cancel'; expectedRowRevision: number;
  }): Promise<{ feature: 'community'; admission: 'enabled' | 'read_only' | 'disabled'; rowRevision: number }> {
    const caller = Object.freeze({ ...trustedCaller });
    invariant(input !== null && typeof input === 'object' && Object.keys(input).every(key => ['feature', 'enabled', 'disposition', 'expectedRowRevision'].includes(key)), 'Invalid feature request');
    invariant(input.feature === 'community' && typeof input.enabled === 'boolean' && ['drain', 'cancel'].includes(input.disposition), 'Unsupported feature admission');
    assertNonNegativeInteger(input.expectedRowRevision, 'expectedRowRevision');
    const change = { ...input }, operation = { capability: 'guild.configure' } as const;
    const facts = await this.authority.readCurrentFacts(caller, operation);
    return this.orm.em.fork().transactional(async em => {
      const permission = await this.authority.authorizeInTransaction(em, caller, operation, facts);
      invariant(permission.allowed, permission.allowed ? '' : permission.reason);
      const installation = await em.findOneOrFail(GuildInstallation, { id: caller.installationId, guildId: caller.guildId });
      const now = new Date(), admission = change.enabled ? 'enabled' : change.disposition === 'drain' ? 'read_only' : 'disabled';
      installation.updateFeatureAdmission(change.expectedRowRevision, { ...installation.featureAdmission, community: admission }, now);
      if (!change.enabled && change.disposition === 'cancel') {
        await this.owners.invalidatePending(em, 'community_disabled', now);
        await this.advanceSafety(em, caller, now);
      }
      await this.recordChange(em, caller, 'administration.feature_admission', now, installation.rowRevision);
      return { feature: 'community', admission, rowRevision: installation.rowRevision };
    });
  }

  /** Preserve pause state while fencing previously prepared work after an invalidating settings change. */
  private async advanceSafety(em: EntityManager, caller: TrustedCallerContext, now: Date): Promise<void> {
    const safety = await em.findOneOrFail(GuildSafetyState, { installationId: caller.installationId, guildId: caller.guildId });
    const actor = { kind: 'user', userId: caller.actorId } as const;
    if (safety.paused) safety.pause(safety.safetyRevision, actor, safety.reasonCode, now);
    else safety.resume(safety.safetyRevision, actor, now);
  }

  /** Audit retains trusted request identity and owner/revision references, never configuration or source content. */
  private async recordChange(em: EntityManager, caller: TrustedCallerContext, operation: string, at: Date, revision: number, retentionDays = 7): Promise<void> {
    await this.audit.recordControlChange(em, caller, operation,
      [{ owner: 'administration', recordId: caller.installationId, revision }], at, retentionDays);
  }
}
