/** Store exact owner-selected provider input with validity bindings, disclosure eligibility and payload erasure. */
import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertNonNegativeInteger, assertUuid, copyJson, invariant, type JsonObject, type ScopedEntityInput } from '../../db/entity-values.js';
import { validateTaskBindings, type TaskSourceUse, type TaskValidityBindings } from './ai-task.entity.js';

export interface PreparedArtifactHandle {
  artifactId: string;
  contentHash: string;
  purpose: string;
}

export interface PreparedInputInput extends ScopedEntityInput {
  taskId: string;
  schemaVersion: number;
  payload: JsonObject;
  contentHash: string;
  artifactHandles: PreparedArtifactHandle[];
  provenance: JsonObject;
  purpose: string;
  audience: JsonObject;
  sourceUse: TaskSourceUse;
  validityBindings: TaskValidityBindings;
  purgeAfter: Date;
  expiresAt?: Date;
}

/** Immutable content selected by the owner; Jobs controls disclosure and erasure. */
@Entity({ tableName: 'prepared_input' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['taskId'] })
@Index({ properties: ['installationId', 'guildId', 'eligible', 'sourceEventId'] })
@Index({ properties: ['installationId', 'guildId', 'eligible', 'privacyScopeId'] })
@Index({ properties: ['installationId', 'guildId', 'eligible', 'policyRevisionId'] })
@Index({ properties: ['cleanupState', 'purgeAfter'] })
@Check({ name: 'prepared_input_check_1', expression: "source_use in ('original_evidence', 'current_source', 'none') and schema_version > 0" })
@Check({ name: 'prepared_input_check_2', expression: "cleanup_state in ('retained', 'pending', 'purged')" })
@Check({ name: 'prepared_input_check_3', expression: 'not eligible or (payload is not null and invalidated_at is null)' })
@Check({ name: 'prepared_input_check_4', expression: "cleanup_state <> 'purged' or (payload is null and payload_purged_at is not null and not eligible)" })
export class PreparedInput extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly taskId: string;
  @Property({ type: 'integer' }) readonly schemaVersion: number;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) payload: JsonObject | null;
  @Property({ type: 'text' }) readonly contentHash: string;
  @Property({ type: 'json', columnType: 'jsonb' }) artifactHandles: PreparedArtifactHandle[];
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) provenance: JsonObject | null;
  @Property({ type: 'text' }) readonly purpose: string;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) audience: JsonObject | null;
  @Property({ type: 'text' }) readonly sourceUse: TaskSourceUse;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly validityBindings: TaskValidityBindings;
  // These columns support bounded invalidation queries without indexing arbitrary JSON keys.
  @Property({ type: 'uuid', nullable: true }) readonly sourceEventId: string | null;
  @Property({ type: 'uuid', nullable: true }) readonly privacyScopeId: string | null;
  @Property({ type: 'uuid', nullable: true }) readonly policyRevisionId: string | null;
  @Property({ type: 'boolean' }) eligible = true;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) invalidatedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) invalidationReason: string | null = null;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) readonly expiresAt: Date | null;
  @Property({ type: 'text' }) cleanupState: 'retained' | 'pending' | 'purged' = 'retained';
  @Property({ type: 'datetime', columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) updatedAt: Date;

  /** Copy the exact owner-selected payload and validity bindings under immutable task and content identities. */
  constructor(input: PreparedInputInput) {
    super(input);
    assertUuid(input.taskId);
    assertNonNegativeInteger(input.schemaVersion, 'Schema version');
    invariant(input.schemaVersion > 0 && input.schemaVersion <= 2_147_483_647, 'Schema version must fit a positive PostgreSQL integer');
    invariant(input.contentHash.length > 0 && input.contentHash.length <= 128, 'A bounded content hash is required');
    invariant(input.purpose.length > 0 && input.purpose.length <= 128, 'A bounded purpose is required');
    invariant(input.payload !== null && typeof input.payload === 'object' && !Array.isArray(input.payload), 'Prepared payload must be an object');
    validateTaskBindings(input.sourceUse, input.validityBindings);
    for (const handle of input.artifactHandles) {
      assertUuid(handle.artifactId);
      invariant(handle.contentHash.length > 0 && handle.purpose.length > 0, 'Artifact handles require a hash and purpose');
    }
    assertDate(input.purgeAfter, 'Input retention deadline');
    invariant(input.purgeAfter > this.createdAt, 'Input retention must follow creation');
    if (input.expiresAt !== undefined) {
      assertDate(input.expiresAt, 'Input expiry');
      invariant(input.expiresAt > this.createdAt && input.expiresAt <= input.purgeAfter, 'Input expiry must precede or equal retention');
    }
    this.taskId = input.taskId;
    this.schemaVersion = input.schemaVersion;
    this.payload = copyJson(input.payload);
    this.contentHash = input.contentHash;
    this.artifactHandles = copyJson(input.artifactHandles);
    this.provenance = copyJson(input.provenance);
    this.purpose = input.purpose;
    this.audience = copyJson(input.audience);
    this.sourceUse = input.sourceUse;
    this.validityBindings = copyJson(input.validityBindings);
    this.sourceEventId = input.validityBindings.sourceEventId ?? null;
    this.privacyScopeId = input.validityBindings.privacyScopeId ?? null;
    this.policyRevisionId = input.validityBindings.policyRevisionId ?? null;
    this.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(this.createdAt);
  }

  /** The store additionally checks task generation/lease and current owner gates under locks. */
  assertDisclosable(now: Date): void {
    assertDate(now, 'Disclosure time');
    invariant(this.eligible && this.payload !== null && this.cleanupState === 'retained', 'Prepared input is unavailable');
    invariant(now < this.purgeAfter && (this.expiresAt === null || now < this.expiresAt), 'Prepared input has expired');
  }

  /** Revocation must commit before object cleanup; it cannot recall already released bytes. */
  invalidate(reason: string, now: Date): void {
    invariant(reason.length > 0 && reason.length <= 256, 'A bounded invalidation reason is required');
    assertDate(now, 'Invalidation time');
    if (!this.eligible) return;
    this.advanceRevision(now);
    this.eligible = false;
    this.invalidatedAt = new Date(now);
    this.invalidationReason = reason;
    this.cleanupState = 'pending';
  }

  /** The caller first records artifact cleanup work in the same transaction. */
  purgePayload(reason: string, now: Date): void {
    invariant(!this.eligible, 'Invalidate input before erasing its payload');
    invariant(reason.length > 0 && reason.length <= 256, 'A bounded purge reason is required');
    assertDate(now, 'Purge time');
    if (this.payloadPurgedAt !== null) return;
    this.advanceRevision(now);
    this.payload = null;
    this.provenance = null;
    this.audience = null;
    this.artifactHandles = [];
    this.cleanupState = 'purged';
    this.payloadPurgedAt = new Date(now);
    this.purgeReason = reason;
  }

  /** Advance the bounded row revision and update time so competing writes can detect stale state. */
  private advanceRevision(now: Date): void {
    assertDate(now, 'Update time');
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    this.rowRevision += 1;
    this.updatedAt = new Date(now);
  }
}
