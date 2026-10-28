/** Persist disposable wake-up messages with lease-bound publication and explicit routing repair. */
import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { RecordEntity } from '../../db/base.entity.js';
import { assertDate, assertDiscordId, assertUuid, invariant, type RecordEntityInput } from '../../db/entity-values.js';

export type OutboxTopic = 'task.execute' | 'task.complete' | 'work.invalidate';
export type OutboxState = 'pending' | 'claimed' | 'published' | 'parked';
export interface OutboxEntryInput extends RecordEntityInput {
  installationId?: string;
  guildId?: string;
  topic: OutboxTopic;
  schemaVersion: 1;
  recordId: string;
  deduplicationKey: string;
  nextAttemptAt?: Date;
}

/** Reference-only wake-up. Publication is not execution, delivery, or owner acceptance. */
@Entity({ tableName: 'outbox_entry' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['deduplicationKey'] })
@Index({ properties: ['state', 'nextAttemptAt'] })
@Index({ properties: ['state', 'leaseUntil'] })
@Check({ name: 'outbox_entry_check_1', expression: '(installation_id is null) = (guild_id is null)' })
@Check({ name: 'outbox_entry_check_2', expression: "topic in ('task.execute', 'task.complete', 'work.invalidate') and schema_version = 1" })
@Check({ name: 'outbox_entry_check_3', expression: "state in ('pending', 'claimed', 'published', 'parked') and claim_generation >= 0 and attempt_count >= 0" })
@Check({ name: 'outbox_entry_check_4', expression: "(state = 'claimed') = (lease_until is not null and claimed_by is not null)" })
@Check({ name: 'outbox_entry_check_5', expression: "state <> 'published' or published_at is not null" })
export class OutboxEntry extends RecordEntity {
  @Property({ type: 'uuid', nullable: true }) readonly installationId: string | null;
  @Property({ type: 'text', nullable: true }) readonly guildId: string | null;
  @Property({ type: 'text' }) readonly topic: OutboxTopic;
  @Property({ type: 'integer' }) readonly schemaVersion: 1;
  /** task.execute/task.complete reference AiTask; work.invalidate references PreparedInput. */
  @Property({ type: 'uuid' }) readonly recordId: string;
  @Property({ type: 'text' }) readonly deduplicationKey: string;
  @Property({ type: 'text' }) state: OutboxState = 'pending';
  @Property({ type: 'integer' }) claimGeneration = 0;
  @Property({ type: 'text', nullable: true }) claimedBy: string | null = null;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) leaseUntil: Date | null = null;
  @Property({ type: 'integer' }) attemptCount = 0;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) nextAttemptAt: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) publishedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) blockedReason: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) updatedAt: Date;

  /** Validate a bounded wake-up envelope and optional installation scope without embedding business payloads. */
  constructor(input: OutboxEntryInput) {
    super(input);
    invariant((input.installationId === undefined) === (input.guildId === undefined), 'Outbox scope must be complete or absent');
    if (input.installationId !== undefined) assertUuid(input.installationId);
    if (input.guildId !== undefined) assertDiscordId(input.guildId);
    invariant(['task.execute', 'task.complete', 'work.invalidate'].includes(input.topic), 'Unsupported outbox topic');
    invariant(input.schemaVersion === 1, 'Unsupported wake-up schema version');
    assertUuid(input.recordId);
    invariant(input.deduplicationKey.length > 0 && input.deduplicationKey.length <= 512, 'A bounded publication deduplication key is required');
    this.installationId = input.installationId ?? null;
    this.guildId = input.guildId ?? null;
    this.topic = input.topic;
    this.schemaVersion = input.schemaVersion;
    this.recordId = input.recordId;
    this.deduplicationKey = input.deduplicationKey;
    this.nextAttemptAt = new Date(input.nextAttemptAt ?? this.createdAt);
    assertDate(this.nextAttemptAt, 'Publication due time');
    this.updatedAt = new Date(this.createdAt);
  }

  /** Expired claims may be reclaimed: consumers must tolerate duplicate publication. */
  claim(executorId: string, leaseUntil: Date, now: Date): number {
    assertDate(now, 'Claim time');
    assertDate(leaseUntil, 'Publication lease');
    invariant(this.state === 'pending' || (this.state === 'claimed' && this.leaseUntil !== null && now >= this.leaseUntil), 'Outbox entry is not claimable');
    invariant(now >= this.nextAttemptAt && leaseUntil > now, 'Publication is not due or lease is invalid');
    invariant(executorId.length > 0 && executorId.length <= 256, 'A bounded relay identity is required');
    invariant(this.claimGeneration < 2_147_483_647 && this.attemptCount < 2_147_483_647, 'Publication counter exhausted');
    this.advanceRevision(now);
    this.claimGeneration += 1;
    this.attemptCount += 1;
    this.state = 'claimed';
    this.claimedBy = executorId;
    this.leaseUntil = new Date(leaseUntil);
    this.blockedReason = null;
    return this.claimGeneration;
  }

  /** Mark publication successful only for the current unexpired publisher claim. */
  recordPublished(generation: number, now: Date): void {
    this.assertClaim(generation, now);
    this.advanceRevision(now);
    this.state = 'published';
    this.publishedAt = new Date(now);
    this.claimedBy = null;
    this.leaseUntil = null;
  }

  /** Release the current publisher claim and retain a bounded reason plus future retry time. */
  scheduleRetry(generation: number, dueAt: Date, reason: string, now: Date): void {
    this.assertClaim(generation, now);
    assertDate(dueAt, 'Publication retry time');
    invariant(dueAt >= now, 'Publication retry cannot precede its decision');
    invariant(reason.length > 0 && reason.length <= 256, 'A bounded transport reason is required');
    this.advanceRevision(now);
    this.state = 'pending';
    this.nextAttemptAt = new Date(dueAt);
    this.blockedReason = reason;
    this.claimedBy = null;
    this.leaseUntil = null;
  }

  /** Stop publication with an explicit routing problem while releasing the active lease. */
  park(generation: number, reason: string, now: Date): void {
    this.assertClaim(generation, now);
    invariant(reason.length > 0 && reason.length <= 256, 'A bounded routing reason is required');
    this.advanceRevision(now);
    this.state = 'parked';
    this.blockedReason = reason;
    this.claimedBy = null;
    this.leaseUntil = null;
  }

  /** Requeue a parked wake-up after routing is repaired without creating a second business operation. */
  resumeAfterRoutingRepair(now: Date): void {
    invariant(this.state === 'parked', 'Outbox entry is not parked');
    this.advanceRevision(now);
    this.state = 'pending';
    this.blockedReason = null;
    this.nextAttemptAt = new Date(now);
  }

  /** Require the current publication generation and live lease before recording transport outcomes. */
  private assertClaim(generation: number, now: Date): void {
    assertDate(now, 'Publication result time');
    invariant(this.state === 'claimed' && this.claimGeneration === generation && this.leaseUntil !== null && now < this.leaseUntil, 'Publication claim is stale');
  }

  /** Advance the bounded row revision and update time so competing writes can detect stale state. */
  private advanceRevision(now: Date): void {
    assertDate(now, 'Update time');
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    this.rowRevision += 1;
    this.updatedAt = new Date(now);
  }
}
