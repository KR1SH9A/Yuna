/** Retain authentic original-create evidence and explicit capture gaps without replacing it with later edits. */
import { createHash } from 'node:crypto';
import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface OriginalAttachmentDescriptor {
  id: string;
  filename: string;
  contentType: string | null;
  byteSize: number;
  description: string | null;
}
export interface OriginalArtifactReference { attachmentId: string; artifactId: string; sha256: string }
export interface CaptureCoverage {
  schemaVersion: 1;
  contentAccess: 'available' | 'restricted' | 'missing';
  body: 'captured' | 'missing';
  attachments: 'complete' | 'partial' | 'missing' | 'none';
}
export interface EvidenceRevisionInput extends ScopedEntityInput {
  caseId: string;
  captureRevision: number;
  originalEventId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  originalAuthorUserId: string | null;
  authorKind: 'user' | 'bot' | 'webhook' | 'system' | 'unknown';
  webhookId?: string | null;
  messageType: number;
  originalCreatedAt: Date | null;
  capturedAt: Date;
  originalContent: string | null;
  originalAttachmentDescriptors: OriginalAttachmentDescriptor[];
  artifactReferences: OriginalArtifactReference[];
  captureCoverage: CaptureCoverage;
  missingReasons: string[];
  supersedesEvidenceId?: string | null;
  previousCapture?: EvidenceRevision;
  purgeAfter: Date;
}

/** One authentic create-event capture. A later Discord edit is never a revision of this evidence. */
@Check({ name: 'evidence_revision_check_1', expression: "capture_revision >= 0" })
@Check({ name: 'evidence_revision_check_2', expression: "author_kind IN ('user', 'bot', 'webhook', 'system', 'unknown')" })
@Check({ name: 'evidence_revision_check_3', expression: "(payload_purged_at IS NULL AND purge_reason IS NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND original_content IS NULL AND original_attachment_descriptors IS NULL AND artifact_references IS NULL)" })
@Check({ name: 'evidence_revision_check_4', expression: "purge_after > captured_at" })
@Entity({ tableName: 'evidence_revision' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'caseId', 'captureRevision'] })
export class EvidenceRevision extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly caseId: string;
  @Property({ type: 'integer' }) readonly captureRevision: number;
  @Property({ type: 'uuid' }) readonly originalEventId: string;
  @Property({ type: 'text' }) readonly sourceChannelId: string;
  @Property({ type: 'text' }) readonly sourceMessageId: string;
  @Property({ type: 'text', nullable: true }) readonly originalAuthorUserId: string | null;
  @Property({ type: 'text' }) readonly authorKind: EvidenceRevisionInput['authorKind'];
  @Property({ type: 'text', nullable: true }) readonly webhookId: string | null;
  @Property({ type: 'integer' }) readonly messageType: number;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly originalCreatedAt: Date | null;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly capturedAt: Date;
  @Property({ type: 'text', nullable: true }) originalContent: string | null;
  @Property({ type: 'text', nullable: true }) readonly originalContentHash: string | null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) originalAttachmentDescriptors: OriginalAttachmentDescriptor[] | null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) artifactReferences: OriginalArtifactReference[] | null;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly captureCoverage: CaptureCoverage;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly missingReasons: string[];
  @Property({ type: 'uuid', nullable: true }) readonly supersedesEvidenceId: string | null;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  /** Validate exact source provenance, retained coverage and any completion of the same original capture. */
  constructor(input: EvidenceRevisionInput) {
    super(input);
    for (const value of [input.caseId, input.originalEventId]) assertUuid(value);
    if (input.supersedesEvidenceId) assertUuid(input.supersedesEvidenceId);
    for (const value of [input.sourceChannelId, input.sourceMessageId]) assertDiscordId(value);
    if (input.originalAuthorUserId) assertDiscordId(input.originalAuthorUserId);
    if (input.webhookId) assertDiscordId(input.webhookId);
    assertNonNegativeInteger(input.captureRevision, 'captureRevision');
    assertNonNegativeInteger(input.messageType, 'messageType');
    assertDate(input.capturedAt, 'capturedAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    if (input.originalCreatedAt) assertDate(input.originalCreatedAt, 'originalCreatedAt');
    invariant(input.purgeAfter > input.capturedAt, 'Evidence must expire after capture');
    invariant((input.originalContent !== null) === (input.captureCoverage.body === 'captured'), 'Body coverage must describe actual retained content');
    invariant(input.captureCoverage.body !== 'captured' || input.captureCoverage.contentAccess === 'available', 'Restricted content cannot be treated as a captured original');
    invariant(!['webhook', 'system', 'unknown'].includes(input.authorKind) || input.originalAuthorUserId === null, 'Non-user provenance cannot establish a sanction target');
    invariant(input.originalContent === null || input.originalContent.length <= 100_000, 'Original body must be bounded');
    invariant(input.missingReasons.length <= 100 && input.missingReasons.every((reason) => reason.length > 0 && reason.length <= 120), 'Capture limitations must be bounded');
    invariant(input.originalAttachmentDescriptors.length <= 100 && input.artifactReferences.length <= 100, 'Capture must be bounded');
    const attachmentIds = new Set(input.originalAttachmentDescriptors.map((attachment) => {
      assertDiscordId(attachment.id);
      assertNonNegativeInteger(attachment.byteSize, 'attachment.byteSize');
      return attachment.id;
    }));
    invariant(attachmentIds.size === input.originalAttachmentDescriptors.length, 'Original attachment identities must be unique');
    for (const reference of input.artifactReferences) {
      assertUuid(reference.artifactId);
      invariant(attachmentIds.has(reference.attachmentId), 'Captured media must belong to the original attachment set');
      invariant(/^[a-f0-9]{64}$/.test(reference.sha256), 'Media requires a SHA-256 digest');
    }
    const previous = input.previousCapture;
    if (input.supersedesEvidenceId) {
      invariant(previous !== undefined && previous.id === input.supersedesEvidenceId, 'Capture completion requires its retained predecessor');
      invariant(previous.installationId === this.installationId && previous.guildId === this.guildId && previous.caseId === input.caseId, 'Previous capture belongs to another case or tenant');
      invariant(previous.originalEventId === input.originalEventId && previous.sourceChannelId === input.sourceChannelId && previous.sourceMessageId === input.sourceMessageId, 'A later event cannot replace original provenance');
      invariant(previous.payloadPurgedAt === null && previous.purgeAfter > input.capturedAt, 'Purged evidence cannot be reconstructed from a later source');
      invariant(input.captureRevision === previous.captureRevision + 1, 'Capture revision must follow its predecessor');
      invariant(previous.originalContent === null || previous.originalContent === input.originalContent, 'Capture completion cannot replace the original body');
      invariant(JSON.stringify(previous.originalAttachmentDescriptors) === JSON.stringify(input.originalAttachmentDescriptors), 'Capture completion cannot replace the original attachment set');
      invariant(input.purgeAfter <= previous.purgeAfter, 'Capture completion cannot extend original retention');
    } else invariant(previous === undefined, 'A predecessor requires an explicit supersedes binding');
    this.caseId = input.caseId;
    this.captureRevision = input.captureRevision;
    this.originalEventId = input.originalEventId;
    this.sourceChannelId = input.sourceChannelId;
    this.sourceMessageId = input.sourceMessageId;
    this.originalAuthorUserId = input.originalAuthorUserId;
    this.authorKind = input.authorKind;
    this.webhookId = input.webhookId ?? null;
    this.messageType = input.messageType;
    this.originalCreatedAt = input.originalCreatedAt ? new Date(input.originalCreatedAt) : null;
    this.capturedAt = new Date(input.capturedAt);
    this.originalContent = input.originalContent;
    this.originalContentHash = input.originalContent === null ? null : createHash('sha256').update(input.originalContent).digest('hex');
    this.originalAttachmentDescriptors = copyJson(input.originalAttachmentDescriptors);
    this.artifactReferences = copyJson(input.artifactReferences);
    this.captureCoverage = copyJson(input.captureCoverage);
    this.missingReasons = copyJson(input.missingReasons);
    this.supersedesEvidenceId = input.supersedesEvidenceId ?? null;
    this.purgeAfter = new Date(input.purgeAfter);
  }

  /** The owner invalidates dependent work and schedules artifact deletion in the same transaction. */
  purgePayload(at: Date, reason: string): void {
    assertDate(at, 'purgedAt');
    invariant(reason.length > 0 && reason.length <= 120, 'A bounded purge reason is required');
    if (this.payloadPurgedAt) return;
    this.originalContent = null;
    this.originalAttachmentDescriptors = null;
    this.artifactReferences = null;
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reason;
  }
}
