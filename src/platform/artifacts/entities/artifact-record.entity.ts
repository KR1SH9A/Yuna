import { BigIntType } from '@mikro-orm/core';
import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type JsonObject, type ScopedEntityInput } from '../../db/entity-values.js';

export interface ArtifactRecordInput extends ScopedEntityInput {
  owner: string;
  ownerRecordRef: string;
  retentionScope: string;
  storageKey: string;
  sourceAttachmentId?: string;
  sourceMessageId?: string;
  sourceChannelId?: string;
  originalMetadata?: JsonObject;
  accessBinding: JsonObject;
  uploadDeadline: Date;
  expiresAt: Date;
}

/** Persist before upload. This record owns cleanup even if an upload finishes after cancellation. */
@Entity({ tableName: 'artifact_record' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['storageKey'] })
@Index({ properties: ['state', 'nextAttemptAt'] })
@Index({ properties: ['state', 'expiresAt'] })
@Check({ name: 'artifact_record_check_1', expression: 'expires_at >= upload_deadline and (byte_size is null or byte_size >= 0)' })
@Check({ name: 'artifact_record_check_2', expression: "state <> 'READY' or (verified_hash is not null and byte_size is not null and ready_at is not null)" })
export class ArtifactRecord extends ScopedEntity {
  @Property({ type: 'text' }) readonly owner: string;
  @Property({ type: 'uuid' }) readonly ownerRecordRef: string;
  @Property({ type: 'text' }) readonly retentionScope: string;
  @Property({ type: 'text' }) readonly storageKey: string;
  @Property({ type: 'text' }) state: 'PENDING' | 'READY' | 'DELETING' | 'DELETED' = 'PENDING';
  @Property({ type: 'text', nullable: true }) readonly sourceAttachmentId: string | null;
  @Property({ type: 'text', nullable: true }) readonly sourceMessageId: string | null;
  @Property({ type: 'text', nullable: true }) readonly sourceChannelId: string | null;
  @Property({ type: 'json', nullable: true }) originalMetadata: JsonObject | null;
  @Property({ type: 'json' }) readonly accessBinding: JsonObject;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly uploadDeadline: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly expiresAt: Date;
  @Property({ type: 'text', nullable: true }) verifiedHash: string | null = null;
  @Property({ type: 'text', nullable: true }) mediaType: string | null = null;
  @Property({ type: new BigIntType('number'), nullable: true }) byteSize: number | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readyAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) deletionStartedAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) deletedAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) nextAttemptAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) failureCode: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 0;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;

  constructor(input: ArtifactRecordInput) {
    super(input);
    assertUuid(input.ownerRecordRef);
    assertDate(input.uploadDeadline, 'uploadDeadline');
    assertDate(input.expiresAt, 'expiresAt');
    invariant(input.uploadDeadline > this.createdAt && input.expiresAt >= input.uploadDeadline, 'Invalid artifact lifetime');
    invariant(input.owner.length > 0 && input.retentionScope.length > 0 && input.storageKey.length > 0, 'Artifact ownership and key are required');
    for (const id of [input.sourceAttachmentId, input.sourceMessageId, input.sourceChannelId]) if (id) assertDiscordId(id);
    this.owner = input.owner;
    this.ownerRecordRef = input.ownerRecordRef;
    this.retentionScope = input.retentionScope;
    this.storageKey = input.storageKey;
    this.sourceAttachmentId = input.sourceAttachmentId ?? null;
    this.sourceMessageId = input.sourceMessageId ?? null;
    this.sourceChannelId = input.sourceChannelId ?? null;
    this.originalMetadata = input.originalMetadata ? copyJson(input.originalMetadata) : null;
    this.accessBinding = copyJson(input.accessBinding);
    this.uploadDeadline = new Date(input.uploadDeadline);
    this.expiresAt = new Date(input.expiresAt);
    this.updatedAt = new Date(this.createdAt);
  }

  finalizeUpload(hash: string, mediaType: string, byteSize: number, now: Date, expectedRevision: number): void {
    this.checkWrite(now, expectedRevision);
    assertNonNegativeInteger(byteSize, 'byteSize');
    invariant(this.state === 'PENDING' && now < this.uploadDeadline, 'Upload cannot become available after its deadline or deletion');
    invariant(hash.length > 0 && mediaType.length > 0, 'Verified artifact details are required');
    this.verifiedHash = hash;
    this.mediaType = mediaType;
    this.byteSize = byteSize;
    this.readyAt = new Date(now);
    this.state = 'READY';
    this.touch(now);
  }

  beginDeletion(now: Date, expectedRevision: number): void {
    this.checkWrite(now, expectedRevision);
    if (this.state === 'DELETED' || this.state === 'DELETING') return;
    this.state = 'DELETING';
    this.deletionStartedAt = new Date(now);
    this.nextAttemptAt = new Date(now);
    this.touch(now);
  }

  recordDeletion(now: Date, expectedRevision: number): void {
    this.checkWrite(now, expectedRevision);
    invariant(this.state === 'DELETING', 'Deletion was not requested');
    // An earlier delete cannot rule out a still-authorized late upload.
    invariant(now >= this.uploadDeadline, 'Repeat object cleanup after the upload horizon');
    this.state = 'DELETED';
    this.deletedAt = new Date(now);
    this.originalMetadata = null;
    this.nextAttemptAt = null;
    this.failureCode = null;
    this.touch(now);
  }

  scheduleDeletionRetry(nextAttemptAt: Date, code: string, now: Date, expectedRevision: number): void {
    this.checkWrite(now, expectedRevision);
    assertDate(nextAttemptAt, 'nextAttemptAt');
    invariant(this.state === 'DELETING' && nextAttemptAt > now && code.length > 0, 'Invalid deletion retry');
    this.nextAttemptAt = new Date(nextAttemptAt);
    this.failureCode = code;
    this.touch(now);
  }

  isReadable(now: Date): boolean {
    assertDate(now, 'now');
    return this.state === 'READY' && now < this.expiresAt;
  }
  private checkWrite(now: Date, expectedRevision: number): void {
    assertDate(now, 'now');
    invariant(expectedRevision === this.rowRevision && now >= this.updatedAt, 'Stale artifact write');
    invariant(this.rowRevision < 2_147_483_647, 'Artifact revision exhausted');
  }
  private touch(now: Date): void { this.rowRevision++; this.updatedAt = new Date(now); }
}
