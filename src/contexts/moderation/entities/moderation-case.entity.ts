/** Track the workflow for one authentic original message and its exact current evidence/policy bindings. */
import { nextCounter } from './moderation-values.js';
import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';
import { EvidenceRevision } from './evidence-revision.entity.js';
import { ModerationFinding, type FindingDisposition } from './moderation-finding.entity.js';

export type ModerationPhase = 'awaiting_original' | 'captured' | 'observing' | 'assessing' | 'complete';
export interface ModerationCaseInput extends ScopedEntityInput {
  sourceChannelId: string;
  sourceMessageId: string;
  policyRevisionId: string;
}
export interface ExpectedModerationTask {
  taskId: string;
  phase: 'observing' | 'assessing';
  evidenceRevisionId: string;
  policyRevisionId: string;
  expectedRowRevision: number;
  at: Date;
}

/** A case is one original message, not an editable copy of Discord's current message. */
@Check({ name: 'moderation_case_check_1', expression: "workflow_phase IN ('awaiting_original', 'captured', 'observing', 'assessing', 'complete')" })
@Check({ name: 'moderation_case_check_2', expression: "generation >= 0 AND row_revision > 0" })
@Check({ name: 'moderation_case_check_3', expression: "workflow_phase NOT IN ('observing', 'assessing') OR (expected_task_id IS NOT NULL AND current_evidence_revision_id IS NOT NULL)" })
@Entity({ tableName: 'moderation_case' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'sourceChannelId', 'sourceMessageId'] })
export class ModerationCase extends ScopedEntity {
  @Property({ type: 'text' }) readonly sourceChannelId: string;
  @Property({ type: 'text' }) readonly sourceMessageId: string;
  @Property({ type: 'text', nullable: true }) subjectUserId: string | null = null;
  @Property({ type: 'uuid', nullable: true }) originalEventId: string | null = null;
  @Property({ type: 'text' }) workflowPhase: ModerationPhase = 'awaiting_original';
  @Property({ type: 'text', nullable: true }) disposition: FindingDisposition | null = null;
  @Property({ type: 'uuid', nullable: true }) currentEvidenceRevisionId: string | null = null;
  @Property({ type: 'uuid' }) policyRevisionId: string;
  @Property({ type: 'uuid', nullable: true }) expectedTaskId: string | null = null;
  @Property({ type: 'integer' }) generation = 0;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: 'text', nullable: true }) captureReason: string | null = null;

  /** Create one case for a fixed channel/message identity and the policy revision selected at admission. */
  constructor(input: ModerationCaseInput) {
    super(input);
    assertDiscordId(input.sourceChannelId);
    assertDiscordId(input.sourceMessageId);
    assertUuid(input.policyRevisionId);
    this.sourceChannelId = input.sourceChannelId;
    this.sourceMessageId = input.sourceMessageId;
    this.policyRevisionId = input.policyRevisionId;
    this.updatedAt = new Date(this.createdAt);
  }

  /** The service validates capture provenance; this binding rejects different sources and tenants. */
  completeOriginalCapture(evidence: EvidenceRevision, expectedRowRevision: number, at: Date): void {
    this.checkRevision(expectedRowRevision, at);
    invariant(evidence.installationId === this.installationId && evidence.guildId === this.guildId && evidence.caseId === this.id, 'Evidence must belong to this case');
    invariant(evidence.sourceChannelId === this.sourceChannelId && evidence.sourceMessageId === this.sourceMessageId, 'Evidence must retain the original source identity');
    invariant(evidence.payloadPurgedAt === null && evidence.purgeAfter > at, 'Evidence is unavailable');
    if (this.currentEvidenceRevisionId === evidence.id) return;
    invariant(this.originalEventId === null || this.originalEventId === evidence.originalEventId, 'A later event cannot replace original-create provenance');
    invariant(this.currentEvidenceRevisionId === null || evidence.supersedesEvidenceId === this.currentEvidenceRevisionId, 'Capture completion must supersede the current revision');
    this.originalEventId = evidence.originalEventId;
    this.currentEvidenceRevisionId = evidence.id;
    this.subjectUserId = evidence.originalAuthorUserId;
    this.workflowPhase = 'captured';
    this.disposition = null;
    this.expectedTaskId = null;
    this.captureReason = evidence.captureCoverage.body === 'missing' ? 'original_body_missing' : null;
    this.generation = nextCounter(this.generation);
    this.touch(at);
  }

  /** Admit one next stage or sequential rule; the owner copies prior meaning and acknowledges its result atomically. */
  expectTask(input: ExpectedModerationTask): void {
    this.checkRevision(input.expectedRowRevision, input.at);
    assertUuid(input.taskId);
    invariant(this.currentEvidenceRevisionId === input.evidenceRevisionId && this.policyRevisionId === input.policyRevisionId, 'Task must bind current original evidence and policy');
    invariant(this.currentEvidenceRevisionId !== null, 'Missing original evidence cannot produce an assessment task');
    invariant(input.phase === 'observing' || ['observing', 'captured', 'assessing'].includes(this.workflowPhase), 'Assessment requires captured or observed evidence');
    this.expectedTaskId = input.taskId;
    this.workflowPhase = input.phase;
    this.disposition = null;
    this.generation = nextCounter(this.generation);
    this.touch(input.at);
  }

  /** Called once with all accepted rule findings in the owner's acceptance transaction. */
  acceptFinding(taskId: string, findings: readonly ModerationFinding[], expectedGeneration: number, expectedRowRevision: number, at: Date): void {
    this.checkRevision(expectedRowRevision, at);
    invariant(this.workflowPhase === 'assessing' && this.expectedTaskId === taskId && this.generation === expectedGeneration, 'Stale or unexpected assessment completion');
    invariant(findings.length > 0, 'Acceptance requires findings');
    for (const finding of findings) {
      invariant(finding.installationId === this.installationId && finding.guildId === this.guildId && finding.caseId === this.id, 'Finding belongs to another case');
      invariant(finding.evidenceRevisionId === this.currentEvidenceRevisionId && finding.policyRevisionId === this.policyRevisionId, 'Finding binds stale evidence or policy');
      invariant(finding.payloadPurgedAt === null && finding.purgeAfter > at, 'Finding payload is unavailable');
    }
    this.expectedTaskId = null;
    this.workflowPhase = 'complete';
    this.disposition = findings.some((finding) => finding.disposition === 'violation') ? 'violation'
      : findings.some((finding) => finding.disposition === 'suspicion') ? 'suspicion'
      : findings.some((finding) => finding.disposition === 'incomplete') ? 'incomplete' : 'clear';
    this.touch(at);
  }

  /** Finish unsupported or unavailable evidence explicitly as incomplete without manufacturing an adverse finding. */
  recordDisposition(disposition: 'incomplete', reason: string, expectedRowRevision: number, at: Date): void {
    this.checkRevision(expectedRowRevision, at);
    invariant(reason.length > 0 && reason.length <= 120, 'Incomplete evidence requires a bounded reason');
    this.disposition = disposition;
    this.captureReason = reason;
    this.workflowPhase = 'complete';
    this.expectedTaskId = null;
    this.generation = nextCounter(this.generation);
    this.touch(at);
  }

  /** Policy publication and this invalidation must commit together. */
  adoptPolicy(policyRevisionId: string, expectedRowRevision: number, at: Date): void {
    this.checkRevision(expectedRowRevision, at);
    assertUuid(policyRevisionId);
    if (this.policyRevisionId === policyRevisionId) return;
    this.policyRevisionId = policyRevisionId;
    this.expectedTaskId = null;
    this.disposition = null;
    this.workflowPhase = this.currentEvidenceRevisionId ? 'captured' : 'awaiting_original';
    this.generation = nextCounter(this.generation);
    this.touch(at);
  }

  /** Reject stale case revisions and out-of-order transition timestamps. */
  private checkRevision(expected: number, at: Date): void {
    assertNonNegativeInteger(expected, 'expectedRowRevision');
    assertDate(at, 'at');
    invariant(this.rowRevision === expected, 'Stale case revision');
    invariant(at >= this.updatedAt, 'Transition time cannot move backwards');
  }
  /** Advance the case persistence revision and timestamp after a validated workflow change. */
  private touch(at: Date): void { this.rowRevision = nextCounter(this.rowRevision); this.updatedAt = new Date(at); }
}
