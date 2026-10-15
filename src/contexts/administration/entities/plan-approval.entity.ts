import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertUuid, copyJson, invariant, type JsonObject, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface PlanApprovalInput extends ScopedEntityInput {
  planId: string;
  planHash: string;
  approverId: string;
  approverAuthorityBinding: JsonObject;
  approvedAt: Date;
  expiresAt: Date;
  planExpiresAt: Date;
  purgeAfter: Date;
}

/** Approval evidence can be withdrawn; execution consumption belongs solely to ActionPlan. */
@Entity({ tableName: 'plan_approval' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'planId', 'approverId'] })
@Check({ name: 'plan_approval_check_1', expression: '"expires_at" > "approved_at"' })
@Check({ name: 'plan_approval_check_2', expression: '"withdrawn_at" is null or "withdrawn_at" >= "approved_at"' })
@Check({ name: 'plan_approval_check_3', expression: '"row_revision" >= 1' })
export class PlanApproval extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly planId: string;
  @Property({ type: 'text' }) readonly planHash: string;
  @Property({ type: 'text' }) readonly approverId: string;
  @Property({ type: 'json' }) readonly approverAuthorityBinding: JsonObject;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly approvedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly expiresAt: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) withdrawnAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) invalidatedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) invalidationReason: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;

  constructor(input: PlanApprovalInput) {
    super(input);
    assertUuid(input.planId);
    assertDiscordId(input.approverId);
    assertDate(input.approvedAt, 'approvedAt');
    assertDate(input.expiresAt, 'expiresAt');
    assertDate(input.planExpiresAt, 'planExpiresAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    invariant(input.expiresAt > input.approvedAt && input.expiresAt <= input.planExpiresAt, 'Approval must expire within the plan lifetime');
    invariant(input.purgeAfter >= input.expiresAt && input.planHash.length > 0, 'Invalid approval retention or hash');
    this.planId = input.planId;
    this.planHash = input.planHash;
    this.approverId = input.approverId;
    this.approverAuthorityBinding = copyJson(input.approverAuthorityBinding);
    this.approvedAt = new Date(input.approvedAt);
    this.expiresAt = new Date(input.expiresAt);
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(input.approvedAt);
  }

  isCurrent(at: Date): boolean {
    assertDate(at, 'at');
    return !this.withdrawnAt && !this.invalidatedAt && at >= this.approvedAt && at < this.expiresAt;
  }

  withdraw(at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    assertDate(at, 'at');
    invariant(at >= this.approvedAt, 'Withdrawal predates approval');
    if (this.withdrawnAt) return;
    this.withdrawnAt = new Date(at);
    this.advanceRevision(at);
  }

  invalidate(reasonCode: string, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    assertDate(at, 'at');
    invariant(at >= this.approvedAt && reasonCode.length > 0 && reasonCode.length <= 128, 'Invalid approval invalidation');
    if (this.invalidatedAt) return;
    this.invalidatedAt = new Date(at);
    this.invalidationReason = reasonCode;
    this.advanceRevision(at);
  }

  private advanceRevision(at: Date): void {
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }
}
