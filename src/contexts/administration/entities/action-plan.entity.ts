/** Describe an optional multi-custodian authorization proposal; this staged record never directly authorizes a Discord sanction. */
import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type JsonObject, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export type GovernedOperation =
  | { kind: 'grant_capability'; granteeUserId: string; capability: string; channelIds: readonly string[]; targetUserIds: readonly string[] }
  | { kind: 'revoke_capability'; grantId: string; reasonCode: string };
export interface ApprovalRequirements {
  minimumApprovals: number;
  excludeRequester: boolean;
  excludedUserIds: readonly string[];
}
export interface ActionPlanInput extends ScopedEntityInput {
  operations: readonly GovernedOperation[];
  planHash: string;
  requesterId: string;
  sourceRequestId: string;
  sourceOperationKey: string;
  authorityBinding: JsonObject;
  approvalRequirements: ApprovalRequirements;
  expiresAt: Date;
  purgeAfter: Date;
}

/** Staged capability governance. Moderation bans and administrator-requested unbans bypass this workflow. */
@Entity({ tableName: 'action_plan' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'sourceRequestId', 'sourceOperationKey'] })
@Unique({ properties: ['consumptionReference'] })
@Index({ properties: ['status', 'expiresAt'] })
@Check({ name: 'action_plan_check_1', expression: `"status" in ('pending', 'consumed', 'invalidated', 'expired')` })
@Check({ name: 'action_plan_check_2', expression: `("status" = 'consumed') = ("consumed_at" is not null and "consumption_reference" is not null)` })
@Check({ name: 'action_plan_check_3', expression: '"row_revision" >= 1' })
export class ActionPlan extends ScopedEntity {
  @Property({ type: 'integer' }) readonly schemaVersion = 1;
  @Property({ type: 'json', nullable: true }) operations: readonly GovernedOperation[] | null;
  @Property({ type: 'text' }) readonly planHash: string;
  @Property({ type: 'text' }) readonly requesterId: string;
  @Property({ type: 'text' }) readonly sourceRequestId: string;
  @Property({ type: 'text' }) readonly sourceOperationKey: string;
  @Property({ type: 'json', nullable: true }) authorityBinding: JsonObject | null;
  @Property({ type: 'json' }) readonly approvalRequirements: ApprovalRequirements;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly expiresAt: Date;
  @Property({ type: 'text' }) status: 'pending' | 'consumed' | 'invalidated' | 'expired' = 'pending';
  @Property({ type: 'uuid', nullable: true }) consumptionReference: string | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) consumedAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) invalidatedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) invalidationReason: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  /** Validate and snapshot the proposed operations, excluded approvers and deadlines before the plan can collect approvals. */
  constructor(input: ActionPlanInput) {
    super(input);
    assertDiscordId(input.requesterId);
    assertDate(input.expiresAt, 'expiresAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    invariant(input.expiresAt > this.createdAt && input.purgeAfter >= input.expiresAt, 'Invalid plan lifetime');
    invariant(input.operations.length > 0 && input.planHash.length > 0, 'Exact plan content is required');
    assertNonNegativeInteger(input.approvalRequirements.minimumApprovals, 'minimumApprovals');
    input.approvalRequirements.excludedUserIds.forEach(assertDiscordId);
    invariant(input.sourceRequestId.length > 0 && input.sourceOperationKey.length > 0, 'Plan request identity is required');
    for (const operation of input.operations) {
      invariant(operation.kind === 'grant_capability' || operation.kind === 'revoke_capability', 'Governance cannot authorize moderation actions');
      if (operation.kind === 'grant_capability') {
        assertDiscordId(operation.granteeUserId);
        invariant(operation.capability.length > 0, 'Capability code is required');
        operation.channelIds.forEach(assertDiscordId);
        operation.targetUserIds.forEach(assertDiscordId);
      }
      if (operation.kind === 'revoke_capability') assertUuid(operation.grantId);
    }
    this.operations = copyJson(input.operations);
    this.planHash = input.planHash;
    this.requesterId = input.requesterId;
    this.sourceRequestId = input.sourceRequestId;
    this.sourceOperationKey = input.sourceOperationKey;
    this.authorityBinding = copyJson(input.authorityBinding);
    this.approvalRequirements = copyJson(input.approvalRequirements);
    this.expiresAt = new Date(input.expiresAt);
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(this.createdAt);
  }

  /** The service supplies currently eligible approvals after verifying their scope and authority. */
  consume(input: { planHash: string; eligibleApproverIds: readonly string[]; consumptionReference: string; at: Date }): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    invariant(this.status === 'pending' && this.operations !== null, 'Plan is not consumable');
    assertDate(input.at, 'at');
    assertUuid(input.consumptionReference);
    invariant(input.at >= this.createdAt && input.at < this.expiresAt, 'Plan expired or consumption predates proposal');
    invariant(input.planHash === this.planHash, 'Plan hash changed');
    const approvers = new Set(input.eligibleApproverIds);
    approvers.forEach(assertDiscordId);
    invariant(approvers.size >= this.approvalRequirements.minimumApprovals, 'Insufficient distinct approvals');
    invariant(!this.approvalRequirements.excludeRequester || !approvers.has(this.requesterId), 'Requester approval is excluded');
    invariant(this.approvalRequirements.excludedUserIds.every(id => !approvers.has(id)), 'An excluded approver was supplied');
    this.status = 'consumed';
    this.consumptionReference = input.consumptionReference;
    this.consumedAt = new Date(input.at);
    this.advanceRevision(input.at);
  }

  /** Invalidate a still-pending proposal or approval with a bounded reason; consumed authority is never silently reused. */
  invalidate(reasonCode: string, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    if (this.status === 'invalidated') return;
    invariant(this.status === 'pending', 'Only pending plans can be invalidated');
    assertDate(at, 'at');
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded reason code is required');
    this.status = 'invalidated';
    this.invalidatedAt = new Date(at);
    this.invalidationReason = reasonCode;
    this.advanceRevision(at);
  }

  /** Close a pending record after its expiry time; calling expiry before that deadline is rejected. */
  expire(at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    if (this.status === 'expired') return;
    assertDate(at, 'at');
    invariant(this.status === 'pending' && at >= this.expiresAt, 'Plan is not eligible for expiry');
    this.status = 'expired';
    this.advanceRevision(at);
  }

  /** Erase expired authorization content after it can no longer authorize work, preserving its minimal lifecycle record. */
  purgePayload(reasonCode: string, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    assertDate(at, 'at');
    invariant(this.status !== 'pending', 'Invalidate pending authorization before purging');
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded purge reason is required');
    if (this.payloadPurgedAt) return;
    this.operations = null;
    this.authorityBinding = null;
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reasonCode;
    this.advanceRevision(at);
  }

  /** Advance optimistic concurrency metadata after a valid local state transition. */
  private advanceRevision(at: Date): void {
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }
}
