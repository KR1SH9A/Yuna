/** Preserve each independently authenticated Debate consent and its durable withdrawal. */
import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

import type { DebateConsentScope } from './debate-session.entity.js';

export interface ParticipantConsentInput extends ScopedEntityInput {
  sessionId: string;
  userId: string;
  scopeRevision: number;
  acceptedScope: DebateConsentScope;
  scopeHash: string;
  acceptedAt: Date;
  sourceRequestId: string;
  purgeAfter: Date;
}

/** Scope changes require a new consent; withdrawal preserves the original acceptance facts. */
@Entity({ tableName: 'participant_consent' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'sessionId', 'userId', 'scopeRevision'] })
@Unique({ properties: ['installationId', 'guildId', 'sourceRequestId'] })
@Check({ name: 'participant_consent_check_1', expression: '"withdrawn_at" is null or "withdrawn_at" >= "accepted_at"' })
@Check({ name: 'participant_consent_check_2', expression: '"row_revision" >= 1' })
export class ParticipantConsent extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly sessionId: string;
  @Property({ type: 'text' }) readonly userId: string;
  @Property({ type: 'integer' }) readonly scopeRevision: number;
  @Property({ type: 'json' }) readonly acceptedScope: DebateConsentScope;
  @Property({ type: 'text' }) readonly scopeHash: string;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly acceptedAt: Date;
  @Property({ type: 'text' }) readonly sourceRequestId: string;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) withdrawnAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) withdrawalReason: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;

  /** Validate and copy immutable identity, source bindings and retention before creating this record. */
  constructor(input: ParticipantConsentInput) {
    super(input);
    assertUuid(input.sessionId);
    assertDiscordId(input.userId);
    assertNonNegativeInteger(input.scopeRevision, 'scopeRevision');
    invariant(input.scopeRevision <= 2_147_483_647, 'scopeRevision exceeds the database integer range');
    assertDate(input.acceptedAt, 'acceptedAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    assertDiscordId(input.acceptedScope.audienceChannelId);
    invariant(input.scopeHash.length > 0 && input.sourceRequestId.length > 0, 'Consent requires exact scope and request identity');
    invariant(input.purgeAfter > input.acceptedAt, 'Consent retention is invalid');
    this.sessionId = input.sessionId;
    this.userId = input.userId;
    this.scopeRevision = input.scopeRevision;
    this.acceptedScope = copyJson(input.acceptedScope);
    this.scopeHash = input.scopeHash;
    this.acceptedAt = new Date(input.acceptedAt);
    this.sourceRequestId = input.sourceRequestId;
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(input.acceptedAt);
  }

  /** Record an irreversible withdrawal without rewriting the original acceptance facts. */
  withdraw(reasonCode: string, at: Date): void {
    if (this.withdrawnAt) return;
    assertDate(at, 'at');
    invariant(at >= this.acceptedAt, 'Withdrawal predates acceptance');
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded reason code is required');
    invariant(this.rowRevision < 2_147_483_647, 'Revision exhausted');
    this.withdrawnAt = new Date(at);
    this.withdrawalReason = reasonCode;
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }
}
