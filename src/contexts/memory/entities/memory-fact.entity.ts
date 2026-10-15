import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

import type { MemoryAudience } from './memory-scope.entity.js';

export interface FactSourceProvenance {
  kind: 'message' | 'user_submission';
  sourceRequestId: string;
  channelId: string | null;
  messageId: string | null;
  sourceVersion: number | null;
}
export interface MemoryFactInput extends ScopedEntityInput {
  scopeId: string;
  subjectUserId: string;
  purpose: string;
  consentRevision: number;
  factText: string;
  contentHash: string;
  sourceProvenance: readonly FactSourceProvenance[];
  audience: MemoryAudience;
  acceptedTaskResultId: string | null;
  acceptanceOperationKey: string;
  proposalItemKey: string;
  replacesFactId: string | null;
  acceptedAt: Date;
  expiresAt: Date;
}

/** Immutable accepted content; replacement creates a new fact and deletes the old fact and vectors. */
@Entity({ tableName: 'memory_fact' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'acceptanceOperationKey', 'proposalItemKey'] })
@Index({ properties: ['installationId', 'guildId', 'scopeId', 'expiresAt'] })
@Check({ name: 'memory_fact_check_1', expression: '"expires_at" > "accepted_at"' })
@Check({ name: 'memory_fact_check_2', expression: '"consent_revision" >= 0' })
export class MemoryFact extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly scopeId: string;
  @Property({ type: 'text' }) readonly subjectUserId: string;
  @Property({ type: 'text' }) readonly purpose: string;
  @Property({ type: 'integer' }) readonly consentRevision: number;
  @Property({ type: 'text' }) readonly factText: string;
  @Property({ type: 'text' }) readonly contentHash: string;
  @Property({ type: 'json' }) readonly sourceProvenance: readonly FactSourceProvenance[];
  @Property({ type: 'json' }) readonly audience: MemoryAudience;
  @Property({ type: 'uuid', nullable: true }) readonly acceptedTaskResultId: string | null;
  @Property({ type: 'text' }) readonly acceptanceOperationKey: string;
  @Property({ type: 'text' }) readonly proposalItemKey: string;
  @Property({ type: 'uuid', nullable: true }) readonly replacesFactId: string | null;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly acceptedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly expiresAt: Date;

  constructor(input: MemoryFactInput) {
    super(input);
    assertUuid(input.scopeId);
    assertDiscordId(input.subjectUserId);
    assertNonNegativeInteger(input.consentRevision, 'consentRevision');
    invariant(input.consentRevision <= 2_147_483_647, 'consentRevision exceeds the database integer range');
    if (input.acceptedTaskResultId) assertUuid(input.acceptedTaskResultId);
    if (input.replacesFactId) assertUuid(input.replacesFactId);
    assertDate(input.acceptedAt, 'acceptedAt');
    assertDate(input.expiresAt, 'expiresAt');
    invariant(input.expiresAt > input.acceptedAt, 'Fact must expire after acceptance');
    invariant(input.factText.length > 0 && input.contentHash.length > 0 && input.purpose.length > 0, 'Fact content and purpose are required');
    invariant(input.acceptanceOperationKey.length > 0 && input.proposalItemKey.length > 0, 'Acceptance identity is required');
    invariant(input.sourceProvenance.length > 0, 'Fact provenance is required');
    for (const source of input.sourceProvenance) {
      invariant(source.sourceRequestId.length > 0, 'Source provenance requires an authenticated request');
      if (source.channelId) assertDiscordId(source.channelId);
      if (source.messageId) assertDiscordId(source.messageId);
      if (source.sourceVersion !== null) assertNonNegativeInteger(source.sourceVersion, 'sourceVersion');
      invariant(source.kind !== 'message' || (source.channelId !== null && source.messageId !== null), 'Message provenance requires source IDs');
    }
    if (input.audience.kind === 'channel') assertDiscordId(input.audience.channelId);
    this.scopeId = input.scopeId;
    this.subjectUserId = input.subjectUserId;
    this.purpose = input.purpose;
    this.consentRevision = input.consentRevision;
    this.factText = input.factText;
    this.contentHash = input.contentHash;
    this.sourceProvenance = copyJson(input.sourceProvenance);
    this.audience = copyJson(input.audience);
    this.acceptedTaskResultId = input.acceptedTaskResultId;
    this.acceptanceOperationKey = input.acceptanceOperationKey;
    this.proposalItemKey = input.proposalItemKey;
    this.replacesFactId = input.replacesFactId;
    this.acceptedAt = new Date(input.acceptedAt);
    this.expiresAt = new Date(input.expiresAt);
  }
}
