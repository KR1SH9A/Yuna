import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../db/entity-values.js';
import { validateTaskBindings, type TaskSourceUse, type TaskValidityBindings } from './ai-task.entity.js';

export interface TaskAcceptanceInput extends ScopedEntityInput {
  taskId: string;
  resultId: string;
  owner: string;
  operationKey: string;
  sourceUse: TaskSourceUse;
  validityBindings: TaskValidityBindings;
  decision: 'accepted' | 'discarded';
  reason: string;
  acknowledgedAt?: Date;
  workflowId?: string;
  stage?: string;
}

/** Immutable owner disposition, committed with accepted content and the owner's state change. */
@Entity({ tableName: 'task_acceptance' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['resultId'] })
@Check({ name: 'task_acceptance_check_1', expression: "decision in ('accepted', 'discarded')" })
export class TaskAcceptance extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly taskId: string;
  @Property({ type: 'uuid' }) readonly resultId: string;
  @Property({ type: 'text' }) readonly owner: string;
  @Property({ type: 'text' }) readonly operationKey: string;
  @Property({ type: 'uuid', nullable: true }) readonly workflowId: string | null;
  @Property({ type: 'text', nullable: true }) readonly stage: string | null;
  @Property({ type: 'text' }) readonly sourceUse: TaskSourceUse;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly validityBindings: TaskValidityBindings;
  @Property({ type: 'text' }) readonly decision: 'accepted' | 'discarded';
  @Property({ type: 'text' }) readonly reason: string;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) readonly acknowledgedAt: Date;

  constructor(input: TaskAcceptanceInput) {
    super(input);
    assertUuid(input.taskId);
    assertUuid(input.resultId);
    if (input.workflowId !== undefined) assertUuid(input.workflowId);
    invariant(input.owner.length > 0 && input.owner.length <= 128, 'A bounded owner is required');
    invariant(input.operationKey.length > 0 && input.operationKey.length <= 512, 'A bounded operation key is required');
    invariant(input.reason.length > 0 && input.reason.length <= 256, 'A bounded acceptance reason is required');
    invariant(input.decision === 'accepted' || input.decision === 'discarded', 'Unknown acceptance disposition');
    validateTaskBindings(input.sourceUse, input.validityBindings);
    this.taskId = input.taskId;
    this.resultId = input.resultId;
    this.owner = input.owner;
    this.operationKey = input.operationKey;
    this.workflowId = input.workflowId ?? null;
    this.stage = input.stage ?? null;
    this.sourceUse = input.sourceUse;
    this.validityBindings = copyJson(input.validityBindings);
    this.decision = input.decision;
    this.reason = input.reason;
    this.acknowledgedAt = new Date(input.acknowledgedAt ?? this.createdAt);
    assertDate(this.acknowledgedAt, 'Acknowledgment time');
  }
}
