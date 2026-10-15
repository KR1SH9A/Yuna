import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { BigIntType } from '@mikro-orm/core';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, copyJson, invariant, type JsonObject, type ScopedEntityInput } from '../../db/entity-values.js';

export type IntakeEventKind = 'message_create' | 'message_update' | 'message_delete' | 'report' | 'interaction';
export type SourceValidity = 'present' | 'deleted' | 'unresolved';
export type ContentAccess = 'available' | 'restricted' | 'unknown';
export type AuthorKind = 'user' | 'bot' | 'webhook' | 'system' | 'unknown';

export interface OriginalAttachment {
  id: string;
  filename: string;
  mediaType: string | null;
  byteSize: number | null;
  artifactId: string | null;
}

export interface IntakeEventInput extends ScopedEntityInput {
  eventKind: IntakeEventKind;
  sourceEventKey: string;
  sourceKey?: string;
  targetSourceKey?: string;
  interactionId?: string;
  requestActorId?: string;
  gatewaySessionId?: string;
  shardId?: number;
  gatewaySequence?: number;
  ingressSequence: bigint;
  observedAt: Date;
  messageCreatedAt?: Date;
  messageEditedAt?: Date;
  authorKind: AuthorKind;
  authorUserId?: string;
  webhookId?: string;
  messageType?: number;
  snapshot?: { schemaVersion: 1; fields: JsonObject };
  contentAccess: ContentAccess;
  coverage: string[];
  contentHash?: string;
  originalAttachments?: OriginalAttachment[];
  purgeAfter: Date;
  metadataPurgeAfter: Date;
}

/** One observed event. Original content never changes when the live message changes. */
@Entity({ tableName: 'intake_event' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'sourceEventKey'] })
@Index({ properties: ['purgeAfter'] })
@Index({ name: 'intake_current_source_unique', expression: 'create unique index intake_current_source_unique on intake_event (installation_id, source_key) where is_current_source_marker = true' })
@Check({ name: 'intake_event_check_1', expression: "not is_current_source_marker or (source_key is not null and event_kind in ('message_create', 'message_update', 'message_delete'))" })
@Check({ name: 'intake_event_check_2', expression: 'ingress_sequence >= 0 and source_version >= 0' })
@Check({ name: 'intake_event_check_3', expression: 'metadata_purge_after >= purge_after' })
export class IntakeEvent extends ScopedEntity {
  @Property({ type: 'text' }) readonly eventKind: IntakeEventKind;
  @Property({ type: 'text' }) readonly sourceEventKey: string;
  @Property({ type: 'text', nullable: true }) readonly sourceKey: string | null;
  @Property({ type: 'text', nullable: true }) readonly targetSourceKey: string | null;
  @Property({ type: 'text', nullable: true }) readonly interactionId: string | null;
  @Property({ type: 'text', nullable: true }) readonly requestActorId: string | null;
  @Property({ type: 'text', nullable: true }) readonly gatewaySessionId: string | null;
  @Property({ type: 'integer', nullable: true }) readonly shardId: number | null;
  @Property({ type: 'integer', nullable: true }) readonly gatewaySequence: number | null;
  @Property({ type: new BigIntType('bigint') }) readonly ingressSequence: bigint;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly observedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly messageCreatedAt: Date | null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly messageEditedAt: Date | null;
  @Property({ type: 'text' }) readonly authorKind: AuthorKind;
  @Property({ type: 'text', nullable: true }) readonly authorUserId: string | null;
  @Property({ type: 'text', nullable: true }) readonly webhookId: string | null;
  @Property({ type: 'integer', nullable: true }) readonly messageType: number | null;
  @Property({ type: 'json', nullable: true }) snapshot: IntakeEventInput['snapshot'] | null;
  @Property({ type: 'text' }) readonly contentAccess: ContentAccess;
  @Property({ type: 'json' }) readonly coverage: string[];
  @Property({ type: 'text', nullable: true }) contentHash: string | null;
  @Property({ type: 'json' }) originalAttachments: OriginalAttachment[];
  @Property({ type: 'boolean' }) isCurrentSourceMarker = false;
  @Property({ type: 'text' }) sourceValidity: SourceValidity;
  @Property({ type: 'integer' }) sourceVersion = 0;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) deletedObservedAt: Date | null;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly metadataPurgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  constructor(input: IntakeEventInput) {
    super(input);
    invariant(input.sourceEventKey.length > 0, 'Event identity is required');
    invariant(input.ingressSequence >= 0n && input.ingressSequence <= 9_223_372_036_854_775_807n, 'Invalid ingress sequence');
    for (const [name, value] of [['observedAt', input.observedAt], ['purgeAfter', input.purgeAfter], ['metadataPurgeAfter', input.metadataPurgeAfter]] as const) assertDate(value, name);
    invariant(input.purgeAfter >= input.observedAt && input.metadataPurgeAfter >= input.purgeAfter, 'Invalid intake retention window');
    for (const id of [input.authorUserId, input.webhookId, input.interactionId, input.requestActorId]) if (id !== undefined) assertDiscordId(id);
    for (const value of [input.shardId, input.gatewaySequence, input.messageType]) if (value !== undefined) assertNonNegativeInteger(value, 'Transport value');
    if (input.messageCreatedAt) assertDate(input.messageCreatedAt, 'messageCreatedAt');
    if (input.messageEditedAt) assertDate(input.messageEditedAt, 'messageEditedAt');
    invariant(!input.authorUserId || input.authorKind === 'user' || input.authorKind === 'bot', 'Only user/bot provenance establishes a user author');
    invariant(!input.eventKind.startsWith('message_') || !!input.sourceKey, 'Message observations require a source key');
    invariant(input.eventKind !== 'message_delete' || input.snapshot === undefined, 'Deletion does not supply original content');
    this.eventKind = input.eventKind;
    this.sourceEventKey = input.sourceEventKey;
    this.sourceKey = input.sourceKey ?? null;
    this.targetSourceKey = input.targetSourceKey ?? null;
    this.interactionId = input.interactionId ?? null;
    this.requestActorId = input.requestActorId ?? null;
    this.gatewaySessionId = input.gatewaySessionId ?? null;
    this.shardId = input.shardId ?? null;
    this.gatewaySequence = input.gatewaySequence ?? null;
    this.ingressSequence = input.ingressSequence;
    this.observedAt = new Date(input.observedAt);
    this.messageCreatedAt = input.messageCreatedAt ? new Date(input.messageCreatedAt) : null;
    this.messageEditedAt = input.messageEditedAt ? new Date(input.messageEditedAt) : null;
    this.authorKind = input.authorKind;
    this.authorUserId = input.authorUserId ?? null;
    this.webhookId = input.webhookId ?? null;
    this.messageType = input.messageType ?? null;
    this.snapshot = input.snapshot ? copyJson(input.snapshot) : null;
    this.contentAccess = input.contentAccess;
    this.coverage = [...input.coverage];
    this.contentHash = input.contentHash ?? null;
    this.originalAttachments = copyJson(input.originalAttachments ?? []);
    this.sourceValidity = input.eventKind === 'message_delete' ? 'deleted' : 'unresolved';
    this.deletedObservedAt = input.eventKind === 'message_delete' ? new Date(input.observedAt) : null;
    this.purgeAfter = new Date(input.purgeAfter);
    this.metadataPurgeAfter = new Date(input.metadataPurgeAfter);
  }

  /** Caller serializes the source key and rejects stale observations before replacing its marker. */
  markCurrent(sourceVersion: number, validity: SourceValidity): void {
    invariant(this.eventKind.startsWith('message_') && this.sourceKey !== null, 'Commands cannot become message markers');
    assertNonNegativeInteger(sourceVersion, 'sourceVersion');
    invariant(sourceVersion > this.sourceVersion && sourceVersion <= 2_147_483_647, 'Source version must advance within storage range');
    invariant(this.eventKind !== 'message_delete' || validity !== 'present', 'Deletion cannot mark a source present');
    this.sourceVersion = sourceVersion;
    this.sourceValidity = validity;
    this.isCurrentSourceMarker = true;
  }

  retireMarker(): void { this.isCurrentSourceMarker = false; }

  purgePayload(now: Date, reason: string): void {
    assertDate(now, 'now');
    invariant(now >= this.observedAt && reason.length > 0, 'Purge needs a valid time and reason');
    if (this.payloadPurgedAt) return;
    this.snapshot = null;
    this.contentHash = null;
    this.originalAttachments = [];
    this.payloadPurgedAt = new Date(now);
    this.purgeReason = reason;
  }
}
