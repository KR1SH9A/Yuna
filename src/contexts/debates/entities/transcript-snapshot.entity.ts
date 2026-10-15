import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface TranscriptSnapshotInput extends ScopedEntityInput {
  sessionId: string;
  revision: number;
  orderedEntryIds: readonly string[];
  contentHash: string;
  declaredCoverage: { firstSequence: number; lastSequence: number; complete: boolean };
  gaps: readonly { afterSequence: number; reasonCode: string }[];
  frozenAt: Date;
  purgeAfter: Date;
  earliestEntryExpiry: Date;
}

/** Exact frozen entry selection; a hash cannot make purged entries available again. */
@Entity({ tableName: 'transcript_snapshot' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'sessionId', 'revision'] })
@Check({ name: 'transcript_snapshot_check_1', expression: '"revision" >= 0' })
export class TranscriptSnapshot extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly sessionId: string;
  @Property({ type: 'integer' }) readonly revision: number;
  @Property({ type: 'json', nullable: true }) orderedEntryIds: readonly string[] | null;
  @Property({ type: 'text' }) readonly contentHash: string;
  @Property({ type: 'json' }) readonly declaredCoverage: TranscriptSnapshotInput['declaredCoverage'];
  @Property({ type: 'json', nullable: true }) gaps: TranscriptSnapshotInput['gaps'] | null;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly frozenAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  constructor(input: TranscriptSnapshotInput) {
    super(input);
    assertUuid(input.sessionId);
    assertNonNegativeInteger(input.revision, 'revision');
    invariant(input.revision <= 2_147_483_647, 'revision exceeds the database integer range');
    input.orderedEntryIds.forEach(assertUuid);
    assertDate(input.frozenAt, 'frozenAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    assertDate(input.earliestEntryExpiry, 'earliestEntryExpiry');
    invariant(input.orderedEntryIds.length > 0 && new Set(input.orderedEntryIds).size === input.orderedEntryIds.length, 'Snapshot requires a distinct ordered entry selection');
    invariant(input.contentHash.length > 0, 'Snapshot content binding is required');
    invariant(input.purgeAfter > input.frozenAt && input.purgeAfter <= input.earliestEntryExpiry, 'Snapshot cannot extend entry retention');
    assertNonNegativeInteger(input.declaredCoverage.firstSequence, 'firstSequence');
    assertNonNegativeInteger(input.declaredCoverage.lastSequence, 'lastSequence');
    invariant(input.declaredCoverage.lastSequence >= input.declaredCoverage.firstSequence, 'Invalid transcript range');
    invariant(!input.declaredCoverage.complete || input.gaps.length === 0, 'Complete coverage cannot contain gaps');
    this.sessionId = input.sessionId;
    this.revision = input.revision;
    this.orderedEntryIds = [...input.orderedEntryIds];
    this.contentHash = input.contentHash;
    this.declaredCoverage = copyJson(input.declaredCoverage);
    this.gaps = copyJson(input.gaps);
    this.frozenAt = new Date(input.frozenAt);
    this.purgeAfter = new Date(input.purgeAfter);
  }

  purgePayload(reasonCode: string, at: Date): void {
    assertDate(at, 'at');
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded purge reason is required');
    if (this.payloadPurgedAt) return;
    this.orderedEntryIds = null;
    this.gaps = null;
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reasonCode;
  }
}
