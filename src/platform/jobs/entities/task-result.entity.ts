/** Store one immutable terminal execution envelope while allowing retained result payloads to be erased. */
import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertNonNegativeInteger, assertUuid, copyJson, invariant, type JsonObject, type ScopedEntityInput } from '../../db/entity-values.js';

export type TaskResultOutcome = 'success' | 'uncertain' | 'failure' | 'canceled' | 'expired';
export interface TaskResultInput extends ScopedEntityInput {
  taskId: string;
  outcome: TaskResultOutcome;
  schemaVersion: number;
  reason: string;
  purgeAfter: Date;
  attemptId?: string;
  attemptGeneration?: number;
  payload?: JsonObject;
  usageReservationId?: string;
  executionStartedAt?: Date;
  completedAt?: Date;
}

/** Exactly one immutable technical outcome per task; payload erasure preserves this envelope. */
@Entity({ tableName: 'task_result' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['taskId'] })
@Index({ properties: ['pendingOwnerDiscard', 'createdAt'] })
@Index({ properties: ['purgeAfter'] })
@Check({ name: 'task_result_check_1', expression: "outcome in ('success', 'uncertain', 'failure', 'canceled', 'expired') and schema_version > 0" })
@Check({ name: 'task_result_check_2', expression: '(attempt_id is null) = (attempt_generation is null)' })
@Check({ name: 'task_result_check_3', expression: 'attempt_generation is null or attempt_generation > 0' })
@Check({ name: 'task_result_check_4', expression: "attempt_id is not null or outcome in ('canceled', 'expired')" })
@Check({ name: 'task_result_check_5', expression: "outcome <> 'success' or payload is not null or payload_unavailable" })
@Check({ name: 'task_result_check_6', expression: 'not payload_unavailable or (payload is null and payload_purged_at is not null)' })
export class TaskResult extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly taskId: string;
  @Property({ type: 'uuid', nullable: true }) readonly attemptId: string | null;
  @Property({ type: 'integer', nullable: true }) readonly attemptGeneration: number | null;
  @Property({ type: 'text' }) readonly outcome: TaskResultOutcome;
  @Property({ type: 'integer' }) readonly schemaVersion: number;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) payload: JsonObject | null;
  @Property({ type: 'text' }) readonly reason: string;
  @Property({ type: 'uuid', nullable: true }) readonly usageReservationId: string | null;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) readonly executionStartedAt: Date | null;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) readonly completedAt: Date;
  @Property({ type: 'boolean' }) payloadUnavailable = false;
  @Property({ type: 'boolean' }) pendingOwnerDiscard = false;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) updatedAt: Date;

  /** Validate an immutable terminal result envelope independently from later owner acceptance. */
  constructor(input: TaskResultInput) {
    super(input);
    assertUuid(input.taskId);
    invariant(['success', 'uncertain', 'failure', 'canceled', 'expired'].includes(input.outcome), 'Unsupported terminal outcome');
    assertNonNegativeInteger(input.schemaVersion, 'Schema version');
    invariant(input.schemaVersion > 0 && input.schemaVersion <= 2_147_483_647, 'Schema version must fit a positive PostgreSQL integer');
    invariant(input.reason.length > 0 && input.reason.length <= 256, 'A bounded result reason is required');
    invariant((input.attemptId === undefined) === (input.attemptGeneration === undefined), 'Attempt identity and generation must be supplied together');
    if (input.attemptId !== undefined) {
      assertUuid(input.attemptId);
      assertNonNegativeInteger(input.attemptGeneration!, 'Attempt generation');
      invariant(input.attemptGeneration! > 0 && input.attemptGeneration! <= 2_147_483_647, 'Attempt generation must fit a positive PostgreSQL integer');
    } else {
      invariant(input.outcome === 'canceled' || input.outcome === 'expired', 'Only pre-execution cancellation/expiry can omit an attempt');
    }
    if (input.payload !== undefined) invariant(input.payload !== null && typeof input.payload === 'object' && !Array.isArray(input.payload), 'Result payload must be an object');
    invariant(input.outcome !== 'success' || input.payload !== undefined, 'Successful results require validated retained output');
    if (input.usageReservationId !== undefined) assertUuid(input.usageReservationId);
    this.completedAt = new Date(input.completedAt ?? this.createdAt);
    assertDate(this.completedAt, 'Completion time');
    if (input.executionStartedAt !== undefined) {
      assertDate(input.executionStartedAt, 'Execution start');
      invariant(input.executionStartedAt <= this.completedAt, 'Completion cannot precede execution');
    }
    assertDate(input.purgeAfter, 'Result retention deadline');
    invariant(input.purgeAfter > this.createdAt, 'Result retention must follow creation');
    this.taskId = input.taskId;
    this.attemptId = input.attemptId ?? null;
    this.attemptGeneration = input.attemptGeneration ?? null;
    this.outcome = input.outcome;
    this.schemaVersion = input.schemaVersion;
    this.payload = input.payload === undefined ? null : copyJson(input.payload);
    this.reason = input.reason;
    this.usageReservationId = input.usageReservationId ?? null;
    this.executionStartedAt = input.executionStartedAt ? new Date(input.executionStartedAt) : null;
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(this.createdAt);
  }

  /** Erase retained result data and preserve a pending owner-discard signal when acceptance has not yet occurred. */
  purgePayload(input: { reason: string; mode: 'owner_acknowledged' | 'privacy' | 'retention'; ownerAcknowledged: boolean; now: Date }): void {
    invariant(['owner_acknowledged', 'privacy', 'retention'].includes(input.mode), 'Unknown purge mode');
    invariant(input.mode !== 'owner_acknowledged' || input.ownerAcknowledged, 'Ordinary cleanup requires owner acknowledgment');
    invariant(input.reason.length > 0 && input.reason.length <= 256, 'A bounded purge reason is required');
    assertDate(input.now, 'Purge time');
    invariant(input.mode !== 'retention' || input.now >= this.purgeAfter, 'Retention purge is not due');
    if (this.payloadPurgedAt !== null) return;
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    this.payload = null;
    this.payloadUnavailable = true;
    this.payloadPurgedAt = new Date(input.now);
    this.purgeReason = input.reason;
    this.pendingOwnerDiscard = !input.ownerAcknowledged;
    this.rowRevision += 1;
    this.updatedAt = new Date(input.now);
  }

  /** Join the transaction that persists TaskAcceptance; never reconstruct purged output. */
  recordOwnerAcknowledgment(now: Date): void {
    assertDate(now, 'Acknowledgment time');
    if (!this.pendingOwnerDiscard) return;
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    this.pendingOwnerDiscard = false;
    this.rowRevision += 1;
    this.updatedAt = new Date(now);
  }
}
