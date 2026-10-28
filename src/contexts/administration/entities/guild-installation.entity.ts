/** Persist installation identity, operator-approved settings and resumable removal progress. */
import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { RecordEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, copyJson, invariant, type JsonObject } from '../../../platform/db/entity-values.js';

export type InstallationState = 'active' | 'suspended' | 'removing' | 'removed';
export type DiscordAvailability = 'unknown' | 'available' | 'unavailable';
export type FeatureAdmission = Readonly<Record<string, 'enabled' | 'disabled' | 'read_only'>>;
export interface CleanupProgress {
  disposition: 'pending' | 'complete' | 'retained';
  recordedAt: string;
  nextAttemptAt: string | null;
  reasonCode: string | null;
}
export interface GuildInstallationInput {
  id?: string;
  createdAt?: Date;
  guildId: string;
  generation: number;
  registeredAt: Date;
  featureAdmission: FeatureAdmission;
}

/** One installation generation. Removal never changes its identity or reactivates it. */
@Entity({ tableName: 'guild_installation' })
@Unique({ properties: ['id', 'guildId'] })
@Unique({ properties: ['guildId', 'generation'] })
@Unique({ name: 'guild_installation_current_guild_unique', properties: ['guildId'], where: `state in ('active', 'suspended')` })
@Check({ name: 'guild_installation_check_1', expression: '"generation" >= 0' })
@Check({ name: 'guild_installation_check_2', expression: `"state" in ('active', 'suspended', 'removing', 'removed')` })
@Check({ name: 'guild_installation_check_3', expression: `("state" = 'removed') = ("removed_at" is not null)` })
@Check({ name: 'guild_installation_check_4', expression: `"state" not in ('removing', 'removed') or "removal_started_at" is not null` })
@Check({ name: 'guild_installation_check_5', expression: '"row_revision" >= 1' })
@Check({ name: 'guild_installation_policy_revision_check', expression: '"policy_revision" >= 0' })
export class GuildInstallation extends RecordEntity {
  @Property({ type: 'text' }) readonly guildId: string;
  @Property({ type: 'integer' }) readonly generation: number;
  @Property({ type: 'text' }) state: InstallationState = 'active';
  @Property({ type: 'text' }) discordAvailability: DiscordAvailability = 'unknown';
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) availabilityObservedAt: Date | null = null;
  @Property({ type: 'json' }) featureAdmission: FeatureAdmission;
  @Property({ type: 'json', nullable: true }) operatorPolicy: JsonObject | null = null;
  @Property({ type: 'integer' }) policyRevision = 0;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly registeredAt: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) suspendedAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) removalStartedAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) removedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) lifecycleReason: string | null = null;
  @Property({ type: 'json' }) requiredCleanupOwners: readonly string[] = [];
  @Property({ type: 'json' }) cleanupProgress: Readonly<Record<string, CleanupProgress>> = {};
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;

  /** Create a new installation generation with explicit feature admission and registration time. */
  constructor(input: GuildInstallationInput) {
    super(input);
    assertDiscordId(input.guildId);
    assertNonNegativeInteger(input.generation, 'generation');
    invariant(input.generation <= 2_147_483_647, 'generation exceeds the database integer range');
    assertDate(input.registeredAt, 'registeredAt');
    this.guildId = input.guildId;
    this.generation = input.generation;
    this.registeredAt = new Date(input.registeredAt);
    this.featureAdmission = copyJson(input.featureAdmission);
    this.updatedAt = new Date(input.registeredAt);
  }

  /** Store a validated, authorized configuration under the installation lock; old work keeps its snapshots. */
  updateOperatorPolicy(expectedRevision: number, policy: JsonObject, at: Date): void {
    invariant(this.state === 'active' || this.state === 'suspended', 'Removed installation cannot configure');
    invariant(this.policyRevision === expectedRevision, 'Stale operator policy revision');
    invariant(this.policyRevision < 2_147_483_647 && this.rowRevision < 2_147_483_647, 'Policy revision exhausted');
    assertDate(at, 'at');
    invariant(at >= this.updatedAt, 'Configuration time cannot move backwards');
    const copied = copyJson(policy);
    invariant(Buffer.byteLength(JSON.stringify(copied), 'utf8') <= 131_072, 'Operator policy exceeds storage bound');
    this.operatorPolicy = copied;
    this.policyRevision += 1;
    this.advanceRevision(at);
  }

  /** Revise admission under the installation lock; the owning service fences or drains existing work. */
  updateFeatureAdmission(expectedRowRevision: number, admission: FeatureAdmission, at: Date): void {
    invariant(this.state === 'active' || this.state === 'suspended', 'Removed installation cannot configure');
    invariant(this.rowRevision === expectedRowRevision && this.rowRevision < 2_147_483_647, 'Stale installation revision');
    assertDate(at, 'at');
    invariant(at >= this.updatedAt, 'Configuration time cannot move backwards');
    invariant(Object.keys(admission).length <= 16 && Object.entries(admission).every(([key, value]) =>
      /^[a-z][a-z0-9_]{0,63}$/.test(key) && ['enabled', 'disabled', 'read_only'].includes(value)), 'Invalid feature admission');
    this.featureAdmission = copyJson(admission);
    this.advanceRevision(at);
  }

  /** Record the newest observed Discord availability; ignore an older observation so recovery cannot undo a later outage. */
  recordAvailability(value: DiscordAvailability, observedAt: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    assertDate(observedAt, 'observedAt');
    invariant(['unknown', 'available', 'unavailable'].includes(value), 'Invalid availability');
    if (this.availabilityObservedAt && observedAt < this.availabilityObservedAt) return;
    this.discordAvailability = value;
    this.availabilityObservedAt = new Date(observedAt);
    this.advanceRevision(observedAt);
  }

  /** Stop ordinary installation admission while preserving the same generation and a bounded operational reason. */
  suspend(reasonCode: string, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    invariant(this.state === 'active' || this.state === 'suspended', 'Installation cannot suspend');
    assertDate(at, 'at');
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded reason code is required');
    if (this.state === 'suspended') return;
    this.state = 'suspended';
    this.suspendedAt = new Date(at);
    this.lifecycleReason = reasonCode;
    this.advanceRevision(at);
  }

  /** Return a suspended installation to active use; a removed generation can never be resumed. */
  resume(at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    invariant(this.state === 'active' || this.state === 'suspended', 'Removed installation cannot resume');
    assertDate(at, 'at');
    this.state = 'active';
    this.suspendedAt = null;
    this.lifecycleReason = null;
    this.advanceRevision(at);
  }

  /** Services fence admissions in the same transaction and capture every required owner. */
  beginRemoval(requiredOwners: readonly string[], reasonCode: string, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    assertDate(at, 'at');
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded reason code is required');
    if (this.state === 'removing' || this.state === 'removed') return;
    invariant(requiredOwners.length > 0 && new Set(requiredOwners).size === requiredOwners.length,
      'Removal requires distinct cleanup owners');
    invariant(requiredOwners.every(owner => owner.length > 0 && owner.length <= 128), 'Invalid cleanup owner');
    this.requiredCleanupOwners = [...requiredOwners];
    this.cleanupProgress = {};
    this.state = 'removing';
    this.removalStartedAt = new Date(at);
    this.lifecycleReason = reasonCode;
    this.advanceRevision(at);
  }

  /** Accept one captured cleanup owner's progress without allowing a completed disposition to regress. */
  recordCleanupProgress(owner: string, progress: CleanupProgress, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    invariant(this.state === 'removing', 'Cleanup requires a removing installation');
    invariant(this.requiredCleanupOwners.includes(owner), 'Owner is outside the captured cleanup set');
    assertDate(at, 'at');
    invariant(['pending', 'complete', 'retained'].includes(progress.disposition), 'Invalid cleanup disposition');
    invariant(progress.disposition !== 'retained' || !!progress.reasonCode, 'Retained data needs an explicit disposition reason');
    assertDate(new Date(progress.recordedAt), 'progress recordedAt');
    if (progress.nextAttemptAt) assertDate(new Date(progress.nextAttemptAt), 'progress nextAttemptAt');
    const prior = this.cleanupProgress[owner];
    invariant(!prior || prior.disposition === 'pending' || progress.disposition === prior.disposition,
      'A completed cleanup disposition cannot regress');
    this.cleanupProgress = { ...this.cleanupProgress, [owner]: copyJson(progress) };
    this.advanceRevision(at);
  }

  /** Mark removal finished only after every captured owner has completed cleanup or recorded why minimal data must remain. */
  completeRemoval(at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    if (this.state === 'removed') return;
    invariant(this.state === 'removing', 'Removal has not begun');
    invariant(this.requiredCleanupOwners.every(owner => {
      const state = this.cleanupProgress[owner]?.disposition;
      return state === 'complete' || state === 'retained';
    }), 'Every required owner must acknowledge cleanup or an explicit retention disposition');
    assertDate(at, 'at');
    invariant(this.removalStartedAt !== null && at >= this.removalStartedAt, 'Removal completion predates its start');
    this.state = 'removed';
    this.removedAt = new Date(at);
    this.advanceRevision(at);
  }

  /** Advance optimistic concurrency metadata after a valid local state transition. */
  private advanceRevision(at: Date): void {
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }
}
