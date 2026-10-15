import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertUuid, invariant, type ScopedEntityInput } from '../../db/entity-values.js';

export type IntakeOwner = 'moderation' | 'community' | 'memory' | 'debates';
export type IntakeOutcome = 'handled' | 'ignored' | 'expired' | 'failed';
export type IntakeDeliveryState = 'READY' | 'RUNNING' | 'RETRY_WAIT' | 'PARKED' | 'DONE';
export interface IntakeDeliveryInput extends ScopedEntityInput {
  eventId: string;
  owner: IntakeOwner;
  orderKey: string;
  processingDeadline?: Date;
}

/** One owner's receipt; completing it and admitting owner work must share a transaction. */
@Entity({ tableName: 'intake_delivery' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'eventId', 'owner'] })
@Index({ properties: ['state', 'nextAttemptAt'] })
@Check({ name: 'intake_delivery_check_1', expression: "(state = 'DONE') = (completed_at is not null and outcome is not null)" })
@Check({ name: 'intake_delivery_check_2', expression: "(state = 'RUNNING') = (lease_owner is not null and lease_until is not null)" })
@Check({ name: 'intake_delivery_check_3', expression: 'claim_generation >= 0 and attempt_count >= 0 and row_revision >= 0' })
export class IntakeDelivery extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly eventId: string;
  @Property({ type: 'text' }) readonly owner: IntakeOwner;
  @Property({ type: 'text' }) readonly orderKey: string;
  @Property({ type: 'text' }) state: IntakeDeliveryState = 'READY';
  @Property({ type: 'integer' }) claimGeneration = 0;
  @Property({ type: 'text', nullable: true }) leaseOwner: string | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) leaseUntil: Date | null = null;
  @Property({ type: 'integer' }) attemptCount = 0;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) nextAttemptAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly processingDeadline: Date | null;
  @Property({ type: 'text', nullable: true }) outcome: IntakeOutcome | null = null;
  @Property({ type: 'uuid', nullable: true }) ownerRecordRef: string | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) completedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) blockedReason: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 0;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;

  constructor(input: IntakeDeliveryInput) {
    super(input);
    assertUuid(input.eventId);
    invariant(input.orderKey.length > 0, 'Owner ordering key is required');
    if (input.processingDeadline) assertDate(input.processingDeadline, 'processingDeadline');
    this.eventId = input.eventId;
    this.owner = input.owner;
    this.orderKey = input.orderKey;
    this.processingDeadline = input.processingDeadline ? new Date(input.processingDeadline) : null;
    this.updatedAt = new Date(this.createdAt);
  }

  claim(executor: string, now: Date, leaseUntil: Date, expectedRevision: number): number {
    this.checkWrite(now, expectedRevision);
    assertDate(leaseUntil, 'leaseUntil');
    invariant(executor.length > 0 && leaseUntil > now, 'Invalid receipt lease');
    invariant(this.state === 'READY' || (this.state === 'RETRY_WAIT' && this.nextAttemptAt !== null && this.nextAttemptAt <= now), 'Receipt is not ready');
    invariant(this.processingDeadline === null || now < this.processingDeadline, 'Receipt deadline elapsed');
    invariant(this.claimGeneration < 2_147_483_647 && this.attemptCount < 2_147_483_647, 'Receipt counters exhausted');
    this.claimGeneration++;
    this.attemptCount++;
    this.state = 'RUNNING';
    this.leaseOwner = executor;
    this.leaseUntil = new Date(leaseUntil);
    this.nextAttemptAt = null;
    this.blockedReason = null;
    this.touch(now);
    return this.claimGeneration;
  }

  complete(generation: number, outcome: IntakeOutcome, ownerRecordRef: string | null, now: Date): void {
    this.checkClaim(generation, now);
    if (ownerRecordRef !== null) assertUuid(ownerRecordRef);
    this.state = 'DONE';
    this.outcome = outcome;
    this.ownerRecordRef = ownerRecordRef;
    this.completedAt = new Date(now);
    this.clearLease();
    this.touch(now);
  }

  scheduleRetry(generation: number, nextAttemptAt: Date, reason: string, now: Date): void {
    this.checkClaim(generation, now);
    assertDate(nextAttemptAt, 'nextAttemptAt');
    invariant(nextAttemptAt > now && reason.length > 0, 'Retry needs a future time and reason');
    this.state = 'RETRY_WAIT';
    this.nextAttemptAt = new Date(nextAttemptAt);
    this.blockedReason = reason;
    this.clearLease();
    this.touch(now);
  }

  /** Expired receipt claims can be replayed because owner admission and completion commit together. */
  recoverExpiredLease(now: Date, expectedRevision: number): void {
    this.checkWrite(now, expectedRevision);
    invariant(this.state === 'RUNNING' && this.leaseUntil !== null && now >= this.leaseUntil, 'Lease has not expired');
    this.state = 'READY';
    this.clearLease();
    this.touch(now);
  }

  park(generation: number, reason: string, now: Date): void {
    this.checkClaim(generation, now);
    invariant(reason.length > 0, 'Parking reason is required');
    this.state = 'PARKED';
    this.blockedReason = reason;
    this.clearLease();
    this.touch(now);
  }

  resume(now: Date, expectedRevision: number): void {
    this.checkWrite(now, expectedRevision);
    invariant(this.state === 'PARKED', 'Only parked receipts resume');
    this.state = 'READY';
    this.blockedReason = null;
    this.touch(now);
  }

  /** Hard retention or an elapsed processing deadline must leave an explicit terminal receipt. */
  disposeUnavailable(outcome: 'expired' | 'failed', reason: string, now: Date, expectedRevision: number): void {
    this.checkWrite(now, expectedRevision);
    invariant(reason.length > 0, 'Unavailable intake needs a reason');
    invariant(this.state !== 'DONE', 'Receipt already completed');
    invariant(this.state !== 'RUNNING' || this.leaseUntil !== null && now >= this.leaseUntil, 'An active receipt claim must finish or be fenced first');
    this.state = 'DONE';
    this.outcome = outcome;
    this.blockedReason = reason;
    this.completedAt = new Date(now);
    this.nextAttemptAt = null;
    this.clearLease();
    this.touch(now);
  }

  private checkWrite(now: Date, expectedRevision: number): void {
    assertDate(now, 'now');
    invariant(now >= this.updatedAt && expectedRevision === this.rowRevision, 'Stale receipt write');
    invariant(this.rowRevision < 2_147_483_647, 'Receipt revision exhausted');
  }
  private checkClaim(generation: number, now: Date): void {
    this.checkWrite(now, this.rowRevision);
    invariant(this.state === 'RUNNING' && generation === this.claimGeneration && this.leaseUntil !== null && now < this.leaseUntil, 'Stale receipt claim');
  }
  private clearLease(): void { this.leaseOwner = null; this.leaseUntil = null; }
  private touch(now: Date): void { this.rowRevision++; this.updatedAt = new Date(now); }
}
