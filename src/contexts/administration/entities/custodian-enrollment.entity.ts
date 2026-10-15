import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type JsonObject, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface CustodianEnrollmentInput extends ScopedEntityInput {
  candidateId: string;
  proposerId: string;
  sourceRequestId: string;
  sourceOperationKey: string;
  proposedScope: JsonObject;
  governanceRevision: number;
  planId: string;
  expiresAt: Date;
  purgeAfter: Date;
}

/** Candidate acceptance is separate from the exact plan's independent approvals. */
@Entity({ tableName: 'custodian_enrollment' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'sourceRequestId', 'sourceOperationKey'] })
@Unique({ properties: ['resultingGrantId'] })
@Index({ properties: ['status', 'expiresAt'] })
@Check({ name: 'custodian_enrollment_check_1', expression: `"status" in ('pending', 'completed', 'rejected', 'expired')` })
@Check({ name: 'custodian_enrollment_check_2', expression: '("candidate_accepted_at" is null) = ("candidate_acceptance_request_id" is null)' })
@Check({ name: 'custodian_enrollment_check_3', expression: `"status" <> 'completed' or ("candidate_accepted_at" is not null and "resulting_grant_id" is not null and "completed_at" is not null)` })
@Check({ name: 'custodian_enrollment_check_4', expression: '"row_revision" >= 1' })
export class CustodianEnrollment extends ScopedEntity {
  @Property({ type: 'text' }) readonly candidateId: string;
  @Property({ type: 'text' }) readonly proposerId: string;
  @Property({ type: 'text' }) readonly sourceRequestId: string;
  @Property({ type: 'text' }) readonly sourceOperationKey: string;
  @Property({ type: 'json' }) readonly proposedScope: JsonObject;
  @Property({ type: 'integer' }) readonly governanceRevision: number;
  @Property({ type: 'uuid' }) readonly planId: string;
  @Property({ type: 'text' }) status: 'pending' | 'completed' | 'rejected' | 'expired' = 'pending';
  @Property({ type: Date, columnType: 'timestamptz' }) readonly expiresAt: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) candidateAcceptedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) candidateAcceptanceRequestId: string | null = null;
  @Property({ type: 'uuid', nullable: true }) resultingGrantId: string | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) completedAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) rejectedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) rejectionReason: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;

  constructor(input: CustodianEnrollmentInput) {
    super(input);
    assertDiscordId(input.candidateId);
    assertDiscordId(input.proposerId);
    assertUuid(input.planId);
    assertNonNegativeInteger(input.governanceRevision, 'governanceRevision');
    invariant(input.governanceRevision <= 2_147_483_647, 'governanceRevision exceeds the database integer range');
    assertDate(input.expiresAt, 'expiresAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    invariant(input.expiresAt > this.createdAt && input.purgeAfter >= input.expiresAt, 'Invalid enrollment lifetime');
    invariant(input.sourceRequestId.length > 0 && input.sourceOperationKey.length > 0, 'Enrollment request identity is required');
    this.candidateId = input.candidateId;
    this.proposerId = input.proposerId;
    this.sourceRequestId = input.sourceRequestId;
    this.sourceOperationKey = input.sourceOperationKey;
    this.proposedScope = copyJson(input.proposedScope);
    this.governanceRevision = input.governanceRevision;
    this.planId = input.planId;
    this.expiresAt = new Date(input.expiresAt);
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(this.createdAt);
  }

  recordAcceptance(candidateId: string, requestId: string, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    assertDate(at, 'at');
    invariant(candidateId === this.candidateId && requestId.length > 0, 'Acceptance must identify the authenticated candidate');
    if (this.candidateAcceptanceRequestId === requestId) return;
    invariant(this.status === 'pending' && at >= this.createdAt && at < this.expiresAt, 'Enrollment is not accepting consent');
    invariant(this.candidateAcceptedAt === null, 'Candidate acceptance is already bound');
    this.candidateAcceptedAt = new Date(at);
    this.candidateAcceptanceRequestId = requestId;
    this.advanceRevision(at);
  }

  /** The owner consumes the matching governed plan and creates the grant atomically. */
  complete(grantId: string, currentGovernanceRevision: number, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    assertUuid(grantId);
    assertDate(at, 'at');
    if (this.status === 'completed' && this.resultingGrantId === grantId) return;
    invariant(this.status === 'pending' && this.candidateAcceptedAt !== null, 'Candidate acceptance is required');
    invariant(currentGovernanceRevision === this.governanceRevision && at < this.expiresAt, 'Enrollment authorization is stale');
    invariant(at >= this.candidateAcceptedAt, 'Completion predates acceptance');
    this.status = 'completed';
    this.resultingGrantId = grantId;
    this.completedAt = new Date(at);
    this.advanceRevision(at);
  }

  reject(reasonCode: string, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    if (this.status === 'rejected') return;
    invariant(this.status === 'pending', 'Only pending enrollment can be rejected');
    assertDate(at, 'at');
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded reason code is required');
    this.status = 'rejected';
    this.rejectedAt = new Date(at);
    this.rejectionReason = reasonCode;
    this.advanceRevision(at);
  }

  expire(at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    assertDate(at, 'at');
    if (this.status === 'expired') return;
    invariant(this.status === 'pending' && at >= this.expiresAt, 'Enrollment is not eligible for expiry');
    this.status = 'expired';
    this.advanceRevision(at);
  }

  private advanceRevision(at: Date): void {
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }
}
