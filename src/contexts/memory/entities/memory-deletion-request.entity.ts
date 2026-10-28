/** Retain bounded deletion progress without retaining the erased personal fact text. */
import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export type MemoryDeletionSelection =
  | { kind: 'facts'; factIds: readonly string[] }
  | { kind: 'scope_cutoff'; acceptedBefore: string };
export interface MemoryOwnerProgress {
  disposition: 'pending' | 'deleted' | 'retained';
  outstandingReferences: readonly string[];
  reasonCode: string | null;
  recordedAt: string;
}
export interface MemoryDeletionRequestInput extends ScopedEntityInput {
  scopeId: string;
  deletionGeneration: number;
  selection: MemoryDeletionSelection;
  requiredOwners: readonly string[];
  requestedAt: Date;
  purgeAfter: Date;
}

/** Non-content cleanup references may outlive deleted facts; they never prevent physical erasure. */
@Entity({ tableName: 'memory_deletion_request' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'scopeId', 'deletionGeneration'] })
@Index({ properties: ['state', 'nextAttemptAt'] })
@Check({ name: 'memory_deletion_request_check_1', expression: `"state" in ('pending', 'complete')` })
@Check({ name: 'memory_deletion_request_check_2', expression: `("state" = 'complete') = ("completed_at" is not null)` })
@Check({ name: 'memory_deletion_request_check_3', expression: '"row_revision" >= 1' })
export class MemoryDeletionRequest extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly scopeId: string;
  @Property({ type: 'integer' }) readonly deletionGeneration: number;
  @Property({ type: 'json' }) readonly selection: MemoryDeletionSelection;
  @Property({ type: 'json' }) readonly requiredOwners: readonly string[];
  @Property({ type: 'json' }) ownerProgress: Readonly<Record<string, MemoryOwnerProgress>> = {};
  @Property({ type: 'text' }) state: 'pending' | 'complete' = 'pending';
  @Property({ type: Date, columnType: 'timestamptz' }) readonly requestedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) completedAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) nextAttemptAt: Date | null;
  @Property({ type: 'text', nullable: true }) lastErrorCode: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;

  /** Capture the exact scope, deletion generation and owners responsible for copied-data cleanup. */
  constructor(input: MemoryDeletionRequestInput) {
    super(input);
    assertUuid(input.scopeId);
    assertNonNegativeInteger(input.deletionGeneration, 'deletionGeneration');
    invariant(input.deletionGeneration <= 2_147_483_647, 'deletionGeneration exceeds the database integer range');
    assertDate(input.requestedAt, 'requestedAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    invariant(input.purgeAfter > input.requestedAt, 'Deletion request retention is invalid');
    invariant(input.requiredOwners.length > 0 && new Set(input.requiredOwners).size === input.requiredOwners.length, 'Capture distinct required cleanup owners');
    if (input.selection.kind === 'facts') {
      invariant(input.selection.factIds.length > 0 && new Set(input.selection.factIds).size === input.selection.factIds.length, 'Select distinct facts');
      input.selection.factIds.forEach(assertUuid);
    } else assertDate(new Date(input.selection.acceptedBefore), 'acceptedBefore');
    this.scopeId = input.scopeId;
    this.deletionGeneration = input.deletionGeneration;
    this.selection = copyJson(input.selection);
    this.requiredOwners = [...input.requiredOwners];
    this.requestedAt = new Date(input.requestedAt);
    this.purgeAfter = new Date(input.purgeAfter);
    this.nextAttemptAt = input.requestedAt ? new Date(input.requestedAt) : null;
    this.updatedAt = new Date(input.requestedAt);
  }

  /** Accept monotonic progress from a declared cleanup owner for this exact deletion generation. */
  recordOwnerProgress(owner: string, generation: number, progress: MemoryOwnerProgress, at: Date): void {
    invariant(this.state === 'pending' && generation === this.deletionGeneration, 'Deletion progress is stale');
    invariant(this.requiredOwners.includes(owner), 'Unexpected cleanup owner');
    invariant(progress.disposition === 'pending' || progress.outstandingReferences.length === 0, 'Acknowledgment still has outstanding copies');
    invariant(progress.disposition !== 'retained' || !!progress.reasonCode, 'Explicit retention requires a reason');
    const prior = this.ownerProgress[owner];
    invariant(!prior || prior.disposition === 'pending' || prior.disposition === progress.disposition, 'Cleanup acknowledgment cannot regress');
    assertDate(at, 'at');
    invariant(this.rowRevision < 2_147_483_647, 'Revision exhausted');
    this.ownerProgress = { ...this.ownerProgress, [owner]: copyJson(progress) };
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }

  /** Complete only after every required owner has acknowledged deletion or explicit content-free retention. */
  markCompleted(at: Date): void {
    if (this.state === 'complete') return;
    assertDate(at, 'at');
    invariant(this.requiredOwners.every(owner => {
      const progress = this.ownerProgress[owner];
      return progress && (progress.disposition === 'deleted' || progress.disposition === 'retained') && progress.outstandingReferences.length === 0;
    }), 'Cleanup owners have not all acknowledged their disposition');
    invariant(this.rowRevision < 2_147_483_647, 'Revision exhausted');
    this.state = 'complete';
    this.completedAt = new Date(at);
    this.nextAttemptAt = null;
    this.lastErrorCode = null;
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }

  /** Record a bounded retry time and reason while unfinished owner cleanup remains. */
  scheduleRetry(nextAttemptAt: Date, errorCode: string, at: Date): void {
    invariant(this.state === 'pending', 'Completed deletion cannot retry');
    assertDate(at, 'at');
    assertDate(nextAttemptAt, 'nextAttemptAt');
    invariant(nextAttemptAt >= at && errorCode.length > 0 && errorCode.length <= 128, 'Invalid retry schedule');
    invariant(this.rowRevision < 2_147_483_647, 'Revision exhausted');
    this.nextAttemptAt = new Date(nextAttemptAt);
    this.lastErrorCode = errorCode;
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }
}
