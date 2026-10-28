/** Store immutable approved text with independently revisioned visibility, retirement and payload retention. */
import { createHash } from 'node:crypto';
import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';
import { nextRevision } from './community-values.js';

export interface KnowledgeProvenance { schemaVersion: 1; kind: 'staff_submission' | 'document'; sourceReference: string; requestId: string }
export type KnowledgeVisibility = { schemaVersion: 1; kind: 'guild' } | { schemaVersion: 1; kind: 'channels'; channelIds: string[] };
export interface KnowledgeEntryInput extends ScopedEntityInput {
  content: string;
  provenance: KnowledgeProvenance;
  approvalActorId: string;
  approvedAt: Date;
  visibility: KnowledgeVisibility;
  purgeAfter: Date;
}

/** Approved content is immutable. Corrections create another approved row and retire this one. */
@Check({ name: 'knowledge_entry_check_1', expression: "replacement_entry_id IS NULL OR retired_at IS NOT NULL" })
@Check({ name: 'knowledge_entry_check_2', expression: "(payload_purged_at IS NULL AND purge_reason IS NULL AND content IS NOT NULL AND provenance IS NOT NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND content IS NULL AND provenance IS NULL AND retired_at IS NOT NULL)" })
@Check({ name: 'knowledge_entry_check_3', expression: "purge_after > approved_at" })
@Entity({ tableName: 'knowledge_entry' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
export class KnowledgeEntry extends ScopedEntity {
  @Property({ type: 'text', nullable: true }) content: string | null;
  @Property({ type: 'text' }) readonly contentHash: string;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) provenance: KnowledgeProvenance | null;
  @Property({ type: 'text' }) readonly approvalActorId: string;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly approvedAt: Date;
  @Property({ type: 'json', columnType: 'jsonb' }) visibility: KnowledgeVisibility;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) retiredAt: Date | null = null;
  @Property({ type: 'uuid', nullable: true }) replacementEntryId: string | null = null;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  /** Capture approved content and provenance once, with explicit visibility and a bounded retention deadline. */
  constructor(input: KnowledgeEntryInput) {
    super(input);
    invariant(input.content.length > 0 && input.content.length <= 100_000, 'Knowledge content must be bounded and nonempty');
    assertDiscordId(input.approvalActorId);
    assertDate(input.approvedAt, 'approvedAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    invariant(input.purgeAfter > input.approvedAt, 'Knowledge retention must follow approval');
    invariant(input.provenance.schemaVersion === 1 && input.provenance.sourceReference.length > 0 && input.provenance.requestId.length > 0, 'Approval requires source and authenticated request provenance');
    this.validateVisibility(input.visibility);
    this.content = input.content;
    this.contentHash = createHash('sha256').update(input.content).digest('hex');
    this.provenance = copyJson(input.provenance);
    this.approvalActorId = input.approvalActorId;
    this.approvedAt = new Date(input.approvedAt);
    this.visibility = copyJson(input.visibility);
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(this.createdAt);
  }

  /** Widening visibility requires fresh service-level authority; content approval is not changed. */
  changeVisibility(visibility: KnowledgeVisibility, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(this.retiredAt === null && this.payloadPurgedAt === null && this.purgeAfter > at, 'Unavailable knowledge cannot change visibility');
    this.validateVisibility(visibility);
    this.visibility = copyJson(visibility);
    this.touch(at);
  }

  /** Exclude this revision from new retrieval and optionally link an approved same-installation replacement. */
  retire(expectedRowRevision: number, at: Date, replacement?: KnowledgeEntry): void {
    this.check(expectedRowRevision, at);
    invariant(this.retiredAt === null, 'Knowledge is already retired');
    if (replacement) {
      invariant(replacement.installationId === this.installationId && replacement.guildId === this.guildId && replacement.id !== this.id, 'Replacement must be a distinct same-tenant approval');
      invariant(replacement.retiredAt === null && replacement.payloadPurgedAt === null && replacement.approvedAt <= at && replacement.purgeAfter > at, 'Replacement must be approved and available');
    }
    this.retiredAt = new Date(at);
    this.replacementEntryId = replacement?.id ?? null;
    this.touch(at);
  }

  /** Erase text and provenance while preserving only retirement and lineage needed for pending-use checks. */
  purgePayload(reason: string, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(reason.length > 0 && reason.length <= 120, 'A bounded purge reason is required');
    if (this.payloadPurgedAt) return;
    this.retiredAt ??= new Date(at);
    this.content = null;
    this.provenance = null;
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reason;
    this.touch(at);
  }

  /** Require a supported visibility version and unique bounded channel identities. */
  private validateVisibility(value: KnowledgeVisibility): void {
    invariant(value.schemaVersion === 1, 'Unsupported visibility schema');
    if (value.kind === 'channels') {
      invariant(value.channelIds.length > 0 && value.channelIds.length <= 100, 'Channel visibility must be bounded');
      for (const channelId of value.channelIds) assertDiscordId(channelId);
      invariant(new Set(value.channelIds).size === value.channelIds.length, 'Visibility channels must be unique');
    }
  }
  /** Reject stale row revisions and backwards transition times before changing owner state. */
  private check(expected: number, at: Date): void {
    assertDate(at, 'at');
    invariant(this.rowRevision === expected, 'Stale knowledge revision');
    invariant(at >= this.updatedAt && at >= this.approvedAt, 'Transition cannot precede approval or previous changes');
  }
  /** Advance the access revision and copy the transition timestamp after a validated change. */
  private touch(at: Date): void { this.rowRevision = nextRevision(this.rowRevision); this.updatedAt = new Date(at); }
}
