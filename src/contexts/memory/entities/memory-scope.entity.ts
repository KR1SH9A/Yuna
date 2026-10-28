/** Persist a member's private-memory consent and revision fence independently of erasable fact content. */
import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface PurposeConsent { granted: boolean; changedAt: string; sourceRequestId: string }
export type MemoryAudience = { kind: 'subject' } | { kind: 'channel'; channelId: string };
export interface MemoryPrivacyConfiguration {
  purposeConsents: Readonly<Record<string, PurposeConsent>>;
  allowedAudiences: readonly MemoryAudience[];
  retentionConfiguration: { maxAgeSeconds: number };
}
export interface MemoryScopeInput extends ScopedEntityInput {
  userId: string;
  privacy: MemoryPrivacyConfiguration;
}

/** Validate explicit retention, purpose provenance and permitted audiences before storing consent. */
function validatePrivacy(value: MemoryPrivacyConfiguration): void {
  assertNonNegativeInteger(value.retentionConfiguration.maxAgeSeconds, 'maxAgeSeconds');
  invariant(value.retentionConfiguration.maxAgeSeconds > 0, 'Memory retention must be explicit and positive');
  value.allowedAudiences.forEach(audience => {
    if (audience.kind === 'channel') assertDiscordId(audience.channelId);
  });
  Object.entries(value.purposeConsents).forEach(([purpose, consent]) => {
    invariant(purpose.length > 0 && consent.sourceRequestId.length > 0, 'Purpose consent needs authenticated provenance');
    assertDate(new Date(consent.changedAt), 'consent changedAt');
  });
}

/** Staged consent gate, retained through deletion so late inference cannot recreate forgotten facts. */
@Entity({ tableName: 'memory_scope' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'userId'] })
@Check({ name: 'memory_scope_check_1', expression: '"privacy_revision" >= 0' })
@Check({ name: 'memory_scope_check_2', expression: '"row_revision" >= 1' })
export class MemoryScope extends ScopedEntity {
  @Property({ type: 'text' }) readonly userId: string;
  @Property({ type: 'json' }) purposeConsents: Readonly<Record<string, PurposeConsent>>;
  @Property({ type: 'json' }) allowedAudiences: readonly MemoryAudience[];
  @Property({ type: 'json' }) retentionConfiguration: MemoryPrivacyConfiguration['retentionConfiguration'];
  @Property({ type: 'integer' }) privacyRevision = 0;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;

  /** Copy this member's consent settings into a distinct installation-scoped privacy record. */
  constructor(input: MemoryScopeInput) {
    super(input);
    assertDiscordId(input.userId);
    /** Validate explicit retention, purpose provenance and permitted audiences before storing consent. */
    validatePrivacy(input.privacy);
    this.userId = input.userId;
    this.purposeConsents = copyJson(input.privacy.purposeConsents);
    this.allowedAudiences = copyJson(input.privacy.allowedAudiences);
    this.retentionConfiguration = copyJson(input.privacy.retentionConfiguration);
    this.updatedAt = new Date(this.createdAt);
  }

  /** The service invalidates affected prepared inputs in the same transaction. */
  revisePrivacy(privacy: MemoryPrivacyConfiguration, expectedRevision: number, at: Date): void {
    invariant(expectedRevision === this.privacyRevision, 'Stale privacy revision');
    /** Validate explicit retention, purpose provenance and permitted audiences before storing consent. */
    validatePrivacy(privacy);
    assertDate(at, 'at');
    invariant(this.privacyRevision < 2_147_483_647 && this.rowRevision < 2_147_483_647, 'Revision exhausted');
    this.purposeConsents = copyJson(privacy.purposeConsents);
    this.allowedAudiences = copyJson(privacy.allowedAudiences);
    this.retentionConfiguration = copyJson(privacy.retentionConfiguration);
    this.privacyRevision += 1;
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }

  /** Advance the durable revision before deleting facts so late submissions cannot recreate forgotten content. */
  advanceDeletionFence(expectedRevision: number, at: Date): number {
    invariant(expectedRevision === this.privacyRevision, 'Stale deletion fence');
    assertDate(at, 'at');
    invariant(this.privacyRevision < 2_147_483_647 && this.rowRevision < 2_147_483_647, 'Revision exhausted');
    this.privacyRevision += 1;
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
    return this.privacyRevision;
  }
}
