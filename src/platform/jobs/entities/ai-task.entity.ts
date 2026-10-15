import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../db/entity-values.js';

export type TaskSourceUse = 'original_evidence' | 'current_source' | 'none';
export type AiTaskState = 'READY' | 'RUNNING' | 'RETRY_WAIT' | 'PARKED' | 'TERMINAL';

/** Only bindings used by this owner are present; these are trusted admission facts. */
export interface TaskValidityBindings {
  sourceEventId?: string;
  sourceRevision?: number;
  evidenceRevisionId?: string;
  policyRevisionId?: string;
  privacyScopeId?: string;
  privacyRevision?: number;
  safetyRevision?: number;
  audienceRevision?: number;
  ownerRevision?: number;
}

export function validateTaskBindings(sourceUse: TaskSourceUse, bindings: TaskValidityBindings): void {
  invariant(['original_evidence', 'current_source', 'none'].includes(sourceUse), 'Unsupported source use');
  for (const value of [bindings.sourceEventId, bindings.evidenceRevisionId, bindings.policyRevisionId, bindings.privacyScopeId]) {
    if (value !== undefined) assertUuid(value);
  }
  for (const value of [bindings.sourceRevision, bindings.privacyRevision, bindings.safetyRevision, bindings.audienceRevision, bindings.ownerRevision]) {
    if (value !== undefined) assertNonNegativeInteger(value, 'Validity revision');
  }
  if (sourceUse === 'original_evidence') invariant(bindings.evidenceRevisionId !== undefined, 'Original evidence requires a retained evidence revision');
  if (sourceUse === 'current_source') invariant(bindings.sourceEventId !== undefined && bindings.sourceRevision !== undefined, 'Current source requires an observation and revision');
}

export interface AiTaskInput extends ScopedEntityInput {
  owner: string;
  operationKey: string;
  kind: string;
  schemaVersion: number;
  preparedInputId: string;
  inputHash: string;
  sourceUse: TaskSourceUse;
  validityBindings: TaskValidityBindings;
  providerConfigurationVersion: string;
  modelVersion: string;
  promptVersion: string;
  maxAttempts: number;
  workflowId?: string;
  stage?: string;
  expectedVariant?: string;
  deadline?: Date;
}

/** Technical execution only. Owner acceptance is recorded separately in TaskAcceptance. */
@Entity({ tableName: 'ai_task' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'owner', 'operationKey', 'kind', 'schemaVersion'] })
@Unique({ properties: ['preparedInputId'] })
@Index({ properties: ['state', 'nextAttemptAt'] })
@Check({ name: 'ai_task_check_1', expression: "state in ('READY', 'RUNNING', 'RETRY_WAIT', 'PARKED', 'TERMINAL')" })
@Check({ name: 'ai_task_check_2', expression: 'attempt_count >= 0 and attempt_count <= max_attempts and max_attempts > 0 and execution_generation >= 0 and schema_version > 0' })
@Check({ name: 'ai_task_check_3', expression: "(state = 'RUNNING') = (active_attempt_id is not null)" })
export class AiTask extends ScopedEntity {
  @Property({ type: 'text' }) readonly owner: string;
  @Property({ type: 'text' }) readonly operationKey: string;
  @Property({ type: 'text' }) readonly kind: string;
  @Property({ type: 'integer' }) readonly schemaVersion: number;
  @Property({ type: 'uuid', nullable: true }) readonly workflowId: string | null;
  @Property({ type: 'text', nullable: true }) readonly stage: string | null;
  @Property({ type: 'text', nullable: true }) readonly expectedVariant: string | null;
  @Property({ type: 'uuid' }) readonly preparedInputId: string;
  @Property({ type: 'text' }) readonly inputHash: string;
  @Property({ type: 'text' }) readonly sourceUse: TaskSourceUse;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly validityBindings: TaskValidityBindings;
  @Property({ type: 'text' }) readonly providerConfigurationVersion: string;
  @Property({ type: 'text' }) readonly modelVersion: string;
  @Property({ type: 'text' }) readonly promptVersion: string;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) readonly deadline: Date | null;
  @Property({ type: 'text' }) state: AiTaskState = 'READY';
  @Property({ type: 'uuid', nullable: true }) activeAttemptId: string | null = null;
  @Property({ type: 'integer' }) attemptCount = 0;
  @Property({ type: 'integer' }) readonly maxAttempts: number;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) nextAttemptAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) parkReason: string | null = null;
  @Property({ type: 'integer' }) executionGeneration = 0;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) updatedAt: Date;

  constructor(input: AiTaskInput) {
    super(input);
    for (const value of [input.owner, input.operationKey, input.kind, input.inputHash, input.providerConfigurationVersion, input.modelVersion, input.promptVersion]) {
      invariant(value.length > 0 && value.length <= 512, 'Task identity/configuration values must be bounded and nonempty');
    }
    assertNonNegativeInteger(input.schemaVersion, 'Schema version');
    invariant(input.schemaVersion > 0 && input.schemaVersion <= 2_147_483_647, 'Schema version must fit a positive PostgreSQL integer');
    assertNonNegativeInteger(input.maxAttempts, 'Maximum attempts');
    invariant(input.maxAttempts > 0 && input.maxAttempts <= 2_147_483_647, 'Maximum attempts must fit a positive PostgreSQL integer');
    assertUuid(input.preparedInputId);
    if (input.workflowId !== undefined) assertUuid(input.workflowId);
    if (input.deadline !== undefined) {
      assertDate(input.deadline, 'Task deadline');
      invariant(input.deadline > this.createdAt, 'Task deadline must follow creation');
    }
    validateTaskBindings(input.sourceUse, input.validityBindings);
    this.owner = input.owner;
    this.operationKey = input.operationKey;
    this.kind = input.kind;
    this.schemaVersion = input.schemaVersion;
    this.workflowId = input.workflowId ?? null;
    this.stage = input.stage ?? null;
    this.expectedVariant = input.expectedVariant ?? null;
    this.preparedInputId = input.preparedInputId;
    this.inputHash = input.inputHash;
    this.sourceUse = input.sourceUse;
    this.validityBindings = copyJson(input.validityBindings);
    this.providerConfigurationVersion = input.providerConfigurationVersion;
    this.modelVersion = input.modelVersion;
    this.promptVersion = input.promptVersion;
    this.deadline = input.deadline ? new Date(input.deadline) : null;
    this.maxAttempts = input.maxAttempts;
    this.updatedAt = new Date(this.createdAt);
  }

  /** Persist with the attempt, its usage reservation and a conditional row-version check. */
  claimAttempt(attemptId: string, now: Date): number {
    assertUuid(attemptId);
    assertDate(now, 'Claim time');
    invariant(this.state === 'READY' || this.state === 'RETRY_WAIT', 'Task is not claimable');
    invariant(this.deadline === null || now < this.deadline, 'Task deadline has passed');
    invariant(this.nextAttemptAt === null || now >= this.nextAttemptAt, 'Retry is not due');
    invariant(this.attemptCount < this.maxAttempts, 'Attempt limit reached');
    invariant(this.executionGeneration < 2_147_483_647, 'Execution generation exhausted');
    this.advanceRevision(now);
    this.executionGeneration += 1;
    this.attemptCount += 1;
    this.activeAttemptId = attemptId;
    this.state = 'RUNNING';
    this.nextAttemptAt = null;
    this.parkReason = null;
    return this.executionGeneration;
  }

  /** Intermediate errors stay on TaskAttempt and do not create TaskResult rows. */
  scheduleRetry(attemptId: string, generation: number, dueAt: Date, now: Date): void {
    this.assertCurrentAttempt(attemptId, generation);
    assertDate(now, 'Retry decision time');
    assertDate(dueAt, 'Retry due time');
    invariant(dueAt >= now, 'Retry cannot be scheduled in the past');
    invariant(this.attemptCount < this.maxAttempts, 'Attempt limit requires a terminal result');
    invariant(this.deadline === null || dueAt < this.deadline, 'Retry must precede deadline');
    this.advanceRevision(now);
    this.activeAttemptId = null;
    this.state = 'RETRY_WAIT';
    this.nextAttemptAt = new Date(dueAt);
  }

  /** Routing must establish fleet-wide incompatibility before invoking this operation. */
  parkForFleetIncompatibility(reason: string, now: Date): void {
    invariant(this.state === 'READY' || this.state === 'RETRY_WAIT', 'Only idle work may be parked');
    invariant(reason.length > 0 && reason.length <= 256, 'A bounded park reason is required');
    assertDate(now, 'Park time');
    this.advanceRevision(now);
    this.state = 'PARKED';
    this.parkReason = reason;
  }

  resumeAfterRoutingRepair(now: Date): void {
    invariant(this.state === 'PARKED', 'Task is not parked');
    assertDate(now, 'Resume time');
    invariant(this.deadline === null || now < this.deadline, 'Expired work requires finalization');
    this.advanceRevision(now);
    this.state = 'READY';
    this.parkReason = null;
    this.nextAttemptAt = null;
  }

  /** Commit exactly one TaskResult and completion outbox in the same transaction. */
  finalize(generation: number, now: Date): void {
    invariant(this.state !== 'TERMINAL', 'Terminal tasks cannot reopen or finalize twice');
    invariant(generation === this.executionGeneration, 'Stale execution generation');
    assertDate(now, 'Finalization time');
    this.advanceRevision(now);
    this.state = 'TERMINAL';
    this.activeAttemptId = null;
    this.nextAttemptAt = null;
    this.parkReason = null;
  }

  assertCurrentAttempt(attemptId: string, generation: number): void {
    invariant(this.state === 'RUNNING' && this.activeAttemptId === attemptId && this.executionGeneration === generation, 'Attempt no longer owns execution authority');
  }

  private advanceRevision(now: Date): void {
    assertDate(now, 'Update time');
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    this.rowRevision += 1;
    this.updatedAt = new Date(now);
  }
}
