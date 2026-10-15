import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export type FindingDisposition = 'violation' | 'suspicion' | 'clear' | 'incomplete';
export interface FindingEvidenceReference { kind: 'original_body' | 'original_attachment'; attachmentId?: string; start?: number; end?: number; description: string }
export interface FindingCoverage { schemaVersion: 1; inspectedBody: boolean; inspectedAttachmentIds: string[]; limitations: string[] }
export interface ModerationFindingInput extends ScopedEntityInput {
  caseId: string;
  evidenceRevisionId: string;
  policyRevisionId: string;
  ruleId: string;
  ruleVersion: string;
  observationTaskResultId?: string | null;
  assessmentTaskResultId: string;
  supportedFacts: string[];
  evidenceReferences: FindingEvidenceReference[];
  exclusions: string[];
  coverage: FindingCoverage;
  disposition: FindingDisposition;
  acceptedAt: Date;
  purgeAfter: Date;
}

/** Accepted explanation owned by Moderation, independent of disposable Jobs result payloads. */
@Check({ name: 'moderation_finding_check_1', expression: "disposition IN ('violation', 'suspicion', 'clear', 'incomplete')" })
@Check({ name: 'moderation_finding_check_2', expression: "(payload_purged_at IS NULL AND purge_reason IS NULL AND supported_facts IS NOT NULL AND evidence_references IS NOT NULL AND coverage IS NOT NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND supported_facts IS NULL AND evidence_references IS NULL AND coverage IS NULL AND exclusions IS NULL)" })
@Check({ name: 'moderation_finding_check_3', expression: "purge_after > accepted_at" })
@Entity({ tableName: 'moderation_finding' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'assessmentTaskResultId', 'ruleId'] })
export class ModerationFinding extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly caseId: string;
  @Property({ type: 'uuid' }) readonly evidenceRevisionId: string;
  @Property({ type: 'uuid' }) readonly policyRevisionId: string;
  @Property({ type: 'text' }) readonly ruleId: string;
  @Property({ type: 'text' }) readonly ruleVersion: string;
  @Property({ type: 'uuid', nullable: true }) readonly observationTaskResultId: string | null;
  @Property({ type: 'uuid' }) readonly assessmentTaskResultId: string;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) supportedFacts: string[] | null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) evidenceReferences: FindingEvidenceReference[] | null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) exclusions: string[] | null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) coverage: FindingCoverage | null;
  @Property({ type: 'text' }) readonly disposition: FindingDisposition;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly acceptedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  constructor(input: ModerationFindingInput) {
    super(input);
    for (const value of [input.caseId, input.evidenceRevisionId, input.policyRevisionId, input.assessmentTaskResultId]) assertUuid(value);
    if (input.observationTaskResultId) assertUuid(input.observationTaskResultId);
    assertDate(input.acceptedAt, 'acceptedAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    invariant(input.purgeAfter > input.acceptedAt, 'Finding retention must follow acceptance');
    invariant(input.ruleId.length > 0 && input.ruleVersion.length > 0, 'A finding requires an exact rule identity');
    invariant(input.supportedFacts.length <= 100 && input.evidenceReferences.length <= 100, 'Finding payload must be bounded');
    invariant(!['violation', 'suspicion'].includes(input.disposition) || (input.supportedFacts.length > 0 && input.evidenceReferences.length > 0), 'Adverse findings require supported facts and evidence references');
    this.caseId = input.caseId;
    this.evidenceRevisionId = input.evidenceRevisionId;
    this.policyRevisionId = input.policyRevisionId;
    this.ruleId = input.ruleId;
    this.ruleVersion = input.ruleVersion;
    this.observationTaskResultId = input.observationTaskResultId ?? null;
    this.assessmentTaskResultId = input.assessmentTaskResultId;
    this.supportedFacts = copyJson(input.supportedFacts);
    this.evidenceReferences = copyJson(input.evidenceReferences);
    this.exclusions = copyJson(input.exclusions);
    this.coverage = copyJson(input.coverage);
    this.disposition = input.disposition;
    this.acceptedAt = new Date(input.acceptedAt);
    this.purgeAfter = new Date(input.purgeAfter);
  }

  purgePayload(at: Date, reason: string): void {
    assertDate(at, 'purgedAt');
    invariant(reason.length > 0 && reason.length <= 120, 'A bounded purge reason is required');
    if (this.payloadPurgedAt) return;
    this.supportedFacts = null;
    this.evidenceReferences = null;
    this.exclusions = null;
    this.coverage = null;
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reason;
  }
}
