import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export type TranscriptEntryKind = 'message' | 'edit' | 'deletion' | 'gap';
export interface TranscriptContent {
  schemaVersion: 1;
  // Omission means not observed; null means explicitly unavailable. Neither fabricates empty text.
  text?: string | null;
  contentAccess: 'available' | 'restricted' | 'unknown';
}
export interface TranscriptCoverage { complete: boolean; reasons: readonly string[] }
export interface TranscriptEntryInput extends ScopedEntityInput {
  sessionId: string;
  sequence: number;
  kind: TranscriptEntryKind;
  sourceEventKey: string;
  messageId: string | null;
  authorId: string | null;
  sourceCreatedAt: Date | null;
  sourceEditedAt: Date | null;
  capturedAt: Date;
  content: TranscriptContent | null;
  artifactIds: readonly string[];
  contentHash: string | null;
  coverage: TranscriptCoverage;
  purgeAfter: Date;
}

/** Append observations in local receipt order; an edit never overwrites an earlier entry. */
@Entity({ tableName: 'transcript_entry' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'sessionId', 'sequence'] })
@Unique({ properties: ['installationId', 'guildId', 'sessionId', 'sourceEventKey'] })
@Index({ properties: ['purgeAfter'] })
@Check({ name: 'transcript_entry_check_1', expression: '"sequence" > 0' })
@Check({ name: 'transcript_entry_check_2', expression: `"kind" in ('message', 'edit', 'deletion', 'gap')` })
export class TranscriptEntry extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly sessionId: string;
  @Property({ type: 'integer' }) readonly sequence: number;
  @Property({ type: 'text' }) readonly kind: TranscriptEntryKind;
  @Property({ type: 'text' }) readonly sourceEventKey: string;
  @Property({ type: 'text', nullable: true }) readonly messageId: string | null;
  @Property({ type: 'text', nullable: true }) readonly authorId: string | null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly sourceCreatedAt: Date | null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly sourceEditedAt: Date | null;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly capturedAt: Date;
  @Property({ type: 'json', nullable: true }) content: TranscriptContent | null;
  @Property({ type: 'json' }) artifactIds: readonly string[];
  @Property({ type: 'text', nullable: true }) readonly contentHash: string | null;
  @Property({ type: 'json' }) readonly coverage: TranscriptCoverage;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  constructor(input: TranscriptEntryInput) {
    super(input);
    assertUuid(input.sessionId);
    assertNonNegativeInteger(input.sequence, 'sequence');
    invariant(input.sequence <= 2_147_483_647, 'sequence exceeds the database integer range');
    invariant(input.sequence > 0 && input.sourceEventKey.length > 0, 'Transcript sequence and event identity are required');
    if (input.messageId) assertDiscordId(input.messageId);
    if (input.authorId) assertDiscordId(input.authorId);
    if (input.sourceCreatedAt) assertDate(input.sourceCreatedAt, 'sourceCreatedAt');
    if (input.sourceEditedAt) assertDate(input.sourceEditedAt, 'sourceEditedAt');
    assertDate(input.capturedAt, 'capturedAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    input.artifactIds.forEach(assertUuid);
    invariant(input.purgeAfter > input.capturedAt, 'Entry retention is invalid');
    invariant(input.kind === 'gap' || input.messageId !== null, 'Source entries require a message ID');
    invariant((input.kind !== 'message' && input.kind !== 'edit') || input.authorId !== null || input.coverage.reasons.length > 0,
      'Missing attribution must have an explicit coverage limitation');
    invariant((input.kind !== 'deletion' && input.kind !== 'gap') || input.content === null, 'Deletion and gap observations do not supply message content');
    this.sessionId = input.sessionId;
    this.sequence = input.sequence;
    this.kind = input.kind;
    this.sourceEventKey = input.sourceEventKey;
    this.messageId = input.messageId;
    this.authorId = input.authorId;
    this.sourceCreatedAt = input.sourceCreatedAt ? new Date(input.sourceCreatedAt) : null;
    this.sourceEditedAt = input.sourceEditedAt ? new Date(input.sourceEditedAt) : null;
    this.capturedAt = new Date(input.capturedAt);
    this.content = copyJson(input.content);
    this.artifactIds = [...input.artifactIds];
    this.contentHash = input.contentHash;
    this.coverage = copyJson(input.coverage);
    this.purgeAfter = new Date(input.purgeAfter);
  }

  /** Owner invalidates dependent snapshots/tasks and records artifact cleanup in the same transaction. */
  purgePayload(reasonCode: string, at: Date): void {
    assertDate(at, 'at');
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded purge reason is required');
    if (this.payloadPurgedAt) return;
    this.content = null;
    this.artifactIds = [];
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reasonCode;
  }
}
