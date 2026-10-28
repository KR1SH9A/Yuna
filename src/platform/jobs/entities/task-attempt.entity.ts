/** Track one leased execution attempt from input release through provider start and observed completion. */
import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertNonNegativeInteger, assertUuid, invariant, type ScopedEntityInput } from '../../db/entity-values.js';

export type TaskAttemptState = 'claimed' | 'released' | 'executing' | 'finished' | 'fenced';
export type AttemptFailureClass = 'retryable' | 'permanent' | 'uncertain';
export interface TaskAttemptInput extends ScopedEntityInput {
  taskId: string;
  attemptNumber: number;
  generation: number;
  executorId: string;
  reservationId: string;
  leaseUntil: Date;
  claimedAt?: Date;
}

/** One accounted provider opportunity. Fencing removes local authority, not remote spend. */
@Entity({ tableName: 'task_attempt' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'taskId', 'attemptNumber'] })
@Unique({ properties: ['reservationId'] })
@Index({ properties: ['state', 'leaseUntil'] })
@Check({ name: 'task_attempt_check_1', expression: "state in ('claimed', 'released', 'executing', 'finished', 'fenced')" })
@Check({ name: 'task_attempt_check_2', expression: 'attempt_number > 0 and generation > 0 and lease_until > claimed_at' })
@Check({ name: 'task_attempt_check_3', expression: 'started_at is null or input_released_at is not null' })
export class TaskAttempt extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly taskId: string;
  @Property({ type: 'integer' }) readonly attemptNumber: number;
  @Property({ type: 'integer' }) readonly generation: number;
  @Property({ type: 'text' }) readonly executorId: string;
  @Property({ type: 'uuid' }) readonly reservationId: string;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) leaseUntil: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) readonly claimedAt: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) inputReleasedAt: Date | null = null;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) startedAt: Date | null = null;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) finishedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) providerRequestId: string | null = null;
  @Property({ type: 'text' }) state: TaskAttemptState = 'claimed';
  @Property({ type: 'text', nullable: true }) failureClass: AttemptFailureClass | null = null;
  @Property({ type: 'text', nullable: true }) failureCode: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) updatedAt: Date;

  /** Bind an attempt to its reserved usage, executor, generation and initial lease before work starts. */
  constructor(input: TaskAttemptInput) {
    super(input);
    assertUuid(input.taskId);
    assertUuid(input.reservationId);
    assertNonNegativeInteger(input.attemptNumber, 'Attempt number');
    assertNonNegativeInteger(input.generation, 'Attempt generation');
    invariant(input.attemptNumber > 0 && input.attemptNumber <= 2_147_483_647 && input.generation > 0 && input.generation <= 2_147_483_647, 'Attempt number and generation must fit positive PostgreSQL integers');
    invariant(input.executorId.length > 0 && input.executorId.length <= 256, 'A bounded executor identity is required');
    this.claimedAt = new Date(input.claimedAt ?? this.createdAt);
    assertDate(this.claimedAt, 'Claim time');
    assertDate(input.leaseUntil, 'Lease deadline');
    invariant(input.leaseUntil > this.claimedAt, 'Lease must follow claim');
    this.taskId = input.taskId;
    this.attemptNumber = input.attemptNumber;
    this.generation = input.generation;
    this.executorId = input.executorId;
    this.reservationId = input.reservationId;
    this.leaseUntil = new Date(input.leaseUntil);
    this.updatedAt = new Date(this.createdAt);
  }

  /** Caller must also compare AiTask.activeAttemptId and executionGeneration atomically. */
  assertAuthority(generation: number, now: Date): void {
    assertDate(now, 'Attempt operation time');
    invariant(this.generation === generation, 'Stale attempt generation');
    invariant(this.state !== 'finished' && this.state !== 'fenced' && now < this.leaseUntil, 'Attempt has lost its lease');
  }

  /** Extend only the live current attempt lease; expired authority cannot be revived by renewal. */
  renewLease(generation: number, leaseUntil: Date, now: Date): void {
    this.assertAuthority(generation, now);
    assertDate(leaseUntil, 'Renewed lease');
    invariant(leaseUntil > this.leaseUntil && leaseUntil > now, 'Renewal must extend a live lease');
    this.advanceRevision(now);
    this.leaseUntil = new Date(leaseUntil);
  }

  /** Record the single disclosure of prepared input while the attempt still owns execution authority. */
  recordInputRelease(generation: number, now: Date): void {
    this.assertAuthority(generation, now);
    invariant(this.state === 'claimed', 'Input may be released once per attempt');
    this.advanceRevision(now);
    this.inputReleasedAt = new Date(now);
    this.state = 'released';
  }

  /** Record external execution only after input has been released to the current attempt. */
  recordProviderStart(generation: number, now: Date): void {
    this.assertAuthority(generation, now);
    invariant(this.state === 'released', 'Provider execution requires released input');
    this.advanceRevision(now);
    this.startedAt = new Date(now);
    this.state = 'executing';
  }

  /** Finish the current attempt with either observed success or a bounded failure classification. */
  finish(generation: number, now: Date, failure?: { classification: AttemptFailureClass; code: string }, providerRequestId?: string): void {
    this.assertAuthority(generation, now);
    if (failure !== undefined) {
      invariant(['retryable', 'permanent', 'uncertain'].includes(failure.classification), 'Unknown failure classification');
      invariant(failure.code.length > 0 && failure.code.length <= 256, 'A bounded failure code is required');
    } else {
      invariant(this.state === 'executing', 'Successful execution requires a provider start');
    }
    if (providerRequestId !== undefined) invariant(providerRequestId.length > 0 && providerRequestId.length <= 512, 'Provider request identity must be bounded');
    this.advanceRevision(now);
    this.state = 'finished';
    this.finishedAt = new Date(now);
    this.failureClass = failure?.classification ?? null;
    this.failureCode = failure?.code ?? null;
    this.providerRequestId = providerRequestId ?? null;
  }

  /** Recovery can fence an expired attempt; usage reconciliation remains independent. */
  fence(now: Date): void {
    assertDate(now, 'Fence time');
    invariant(this.state !== 'finished', 'A finished attempt cannot be fenced');
    if (this.state === 'fenced') return;
    this.advanceRevision(now);
    this.state = 'fenced';
    this.finishedAt = new Date(now);
  }

  /** Advance the bounded row revision and update time so competing writes can detect stale state. */
  private advanceRevision(now: Date): void {
    assertDate(now, 'Update time');
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    this.rowRevision += 1;
    this.updatedAt = new Date(now);
  }
}
