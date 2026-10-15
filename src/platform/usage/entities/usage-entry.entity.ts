import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../db/entity-values.js';
import { assertExactMoney, assertUsageEvidence, assertUsageUnits, isNoSpendEvidence, type ExactMoney, type UsageEvidence, type UsageOperationKind, type UsageUnits } from './usage-reservation.entity.js';

export type AccountingState = 'estimated' | 'actual' | 'no-spend';
export interface UsageEntryInput extends ScopedEntityInput {
  reservationId: string;
  operationKind: UsageOperationKind;
  operationKey: string;
  provider: string;
  pricingVersion: string;
  currency: string;
  accountingState: AccountingState;
  evidence: UsageEvidence;
  purgeAfter: Date;
  attemptId?: string;
  providerRequestId?: string;
  estimatedCost?: string;
  actualCost?: string;
  reportedUnits?: UsageUnits;
  reconcileAfter?: Date;
}

/** One opportunity's current billing facts; no prompt/output content belongs in accounting. */
@Entity({ tableName: 'usage_entry' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['reservationId'] })
@Unique({ properties: ['installationId', 'guildId', 'operationKind', 'operationKey'] })
@Unique({ properties: ['attemptId'] })
@Index({ properties: ['accountingState', 'reconcileAfter'] })
@Index({ properties: ['guildId', 'provider', 'firstRecordedAt'] })
@Check({ name: 'usage_entry_check_1', expression: "operation_kind in ('task-attempt', 'explicit-operation') and accounting_state in ('estimated', 'actual', 'no-spend')" })
@Check({ name: 'usage_entry_check_2', expression: "accounting_state <> 'estimated' or estimated_cost is not null or (reported_units is not null and reported_units <> '{}'::jsonb)" })
@Check({ name: 'usage_entry_check_3', expression: '(estimated_cost is null or estimated_cost >= 0) and (actual_cost is null or actual_cost >= 0)' })
@Check({ name: 'usage_entry_check_4', expression: "(accounting_state = 'estimated' and actual_cost is null and reconcile_after is not null) or (accounting_state = 'actual' and actual_cost is not null) or (accounting_state = 'no-spend' and actual_cost is not null and actual_cost = 0)" })
export class UsageEntry extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly reservationId: string;
  @Property({ type: 'text' }) readonly operationKind: UsageOperationKind;
  @Property({ type: 'text' }) readonly operationKey: string;
  @Property({ type: 'uuid', nullable: true }) readonly attemptId: string | null;
  @Property({ type: 'text' }) readonly provider: string;
  @Property({ type: 'text', nullable: true }) providerRequestId: string | null;
  @Property({ type: 'text' }) readonly pricingVersion: string;
  @Property({ type: 'text' }) readonly currency: string;
  @Property({ type: 'text' }) accountingState: AccountingState;
  @Property({ type: 'decimal', columnType: 'numeric(38,18)', nullable: true }) readonly estimatedCost: string | null;
  @Property({ type: 'decimal', columnType: 'numeric(38,18)', nullable: true }) actualCost: string | null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) reportedUnits: UsageUnits | null;
  @Property({ type: 'json', columnType: 'jsonb' }) evidence: UsageEvidence[];
  @Property({ type: 'datetime', columnType: 'timestamptz' }) readonly firstRecordedAt: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) lastEvidenceAt: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) reconcileAfter: Date | null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) readonly purgeAfter: Date;

  constructor(input: UsageEntryInput) {
    super(input);
    assertUuid(input.reservationId);
    if (input.attemptId !== undefined) assertUuid(input.attemptId);
    invariant(input.operationKind === 'task-attempt' || input.operationKind === 'explicit-operation', 'Unknown accounting operation kind');
    invariant(input.operationKind !== 'explicit-operation' || input.attemptId === undefined, 'Explicit operation usage cannot reference a task attempt');
    for (const value of [input.operationKey, input.provider, input.pricingVersion]) invariant(value.length > 0 && value.length <= 512, 'Accounting identifiers must be bounded and nonempty');
    if (input.providerRequestId !== undefined) invariant(input.providerRequestId.length > 0 && input.providerRequestId.length <= 512, 'Provider reference must be bounded');
    assertExactMoney({ amount: input.estimatedCost ?? input.actualCost ?? '0', currency: input.currency });
    if (input.estimatedCost !== undefined) assertExactMoney({ amount: input.estimatedCost, currency: input.currency });
    if (input.actualCost !== undefined) assertExactMoney({ amount: input.actualCost, currency: input.currency });
    if (input.reportedUnits !== undefined) assertUsageUnits(input.reportedUnits);
    assertUsageEvidence(input.evidence);
    invariant(['estimated', 'actual', 'no-spend'].includes(input.accountingState), 'Unknown accounting state');
    if (input.accountingState === 'estimated') {
      invariant(input.actualCost === undefined, 'Unresolved usage cannot claim actual cost');
      invariant(input.estimatedCost !== undefined || (input.reportedUnits !== undefined && Object.keys(input.reportedUnits).length > 0), 'Estimated usage needs a cost estimate or bounded unit liability');
      invariant(input.reconcileAfter !== undefined, 'Unresolved usage requires a reconciliation time');
      assertDate(input.reconcileAfter, 'Usage reconciliation time');
      invariant(input.reconcileAfter >= this.createdAt, 'Reconciliation cannot precede recording');
    } else if (input.accountingState === 'actual') {
      invariant(input.actualCost !== undefined, 'Actual usage needs a priced amount');
      invariant(['provider_response', 'provider_invoice', 'billing_correction'].includes(input.evidence.kind), 'Actual usage requires billing evidence');
    } else {
      invariant(isNoSpendEvidence(input.evidence), 'No-spend usage requires positive evidence');
      invariant(input.actualCost === undefined || /^0(?:\.0+)?$/.test(input.actualCost), 'No-spend usage must resolve to zero');
    }
    assertDate(input.purgeAfter, 'Accounting retention deadline');
    invariant(input.purgeAfter > this.createdAt, 'Accounting retention must follow recording');
    this.reservationId = input.reservationId;
    this.operationKind = input.operationKind;
    this.operationKey = input.operationKey;
    this.attemptId = input.attemptId ?? null;
    this.provider = input.provider;
    this.providerRequestId = input.providerRequestId ?? null;
    this.pricingVersion = input.pricingVersion;
    this.currency = input.currency;
    this.accountingState = input.accountingState;
    this.estimatedCost = input.estimatedCost ?? null;
    this.actualCost = input.accountingState === 'no-spend' ? '0' : input.actualCost ?? null;
    this.reportedUnits = input.reportedUnits === undefined ? null : copyJson(input.reportedUnits);
    this.evidence = [copyJson(input.evidence)];
    this.firstRecordedAt = new Date(this.createdAt);
    this.lastEvidenceAt = new Date(input.evidence.observedAt);
    this.reconcileAfter = input.accountingState === 'estimated' ? new Date(input.reconcileAfter!) : null;
    this.updatedAt = new Date(this.createdAt);
    this.purgeAfter = new Date(input.purgeAfter);
  }

  /** Resolve billing independently of whether the owner accepted or discarded the AI result. */
  recordActual(cost: ExactMoney, units: UsageUnits | undefined, evidence: UsageEvidence, now: Date): void {
    invariant(this.accountingState === 'estimated', 'Known usage requires explicit billing correction');
    this.validateActual(cost, units, evidence);
    invariant(evidence.kind !== 'billing_correction', 'Initial settlement is provider response/invoice evidence');
    this.appendEvidence(evidence, now);
    this.accountingState = 'actual';
    this.actualCost = cost.amount;
    this.reportedUnits = units === undefined ? this.reportedUnits : copyJson(units);
    this.reconcileAfter = null;
  }

  recordNoSpend(evidence: UsageEvidence, now: Date): void {
    invariant(this.accountingState === 'estimated', 'Known spend cannot be erased by a no-spend claim');
    assertUsageEvidence(evidence);
    invariant(isNoSpendEvidence(evidence), 'Timeout and expired leases do not prove no spend');
    this.appendEvidence(evidence, now);
    this.accountingState = 'no-spend';
    this.actualCost = '0';
    this.reconcileAfter = null;
  }

  /** Keep explicit correction evidence; do not cap overrun amounts to the reservation. */
  recordBillingCorrection(cost: ExactMoney, units: UsageUnits | undefined, evidence: UsageEvidence, now: Date): void {
    invariant(this.accountingState !== 'estimated', 'Unresolved usage requires initial settlement');
    this.validateActual(cost, units, evidence);
    invariant(evidence.kind === 'billing_correction' && new Date(evidence.observedAt) > this.lastEvidenceAt, 'Correction requires newer explicit billing evidence');
    this.appendEvidence(evidence, now);
    this.accountingState = 'actual';
    this.actualCost = cost.amount;
    this.reportedUnits = units === undefined ? this.reportedUnits : copyJson(units);
    this.reconcileAfter = null;
  }

  recordUncertainty(evidence: UsageEvidence, reconcileAfter: Date, now: Date): void {
    invariant(this.accountingState === 'estimated', 'A later timeout cannot overwrite known actual usage');
    assertUsageEvidence(evidence);
    invariant(evidence.kind === 'timeout' || evidence.kind === 'lease_expired', 'Uncertainty needs execution uncertainty evidence');
    assertDate(reconcileAfter, 'Usage reconciliation time');
    invariant(reconcileAfter > now, 'Unresolved usage requires future reconciliation');
    this.appendEvidence(evidence, now);
    this.reconcileAfter = new Date(reconcileAfter);
  }

  canPurge(now: Date): boolean {
    assertDate(now, 'Retention time');
    return this.accountingState !== 'estimated' && now >= this.purgeAfter;
  }

  private validateActual(cost: ExactMoney, units: UsageUnits | undefined, evidence: UsageEvidence): void {
    assertExactMoney(cost);
    invariant(cost.currency === this.currency, 'Billing cannot change the reserved currency');
    if (units !== undefined) assertUsageUnits(units);
    assertUsageEvidence(evidence);
    invariant(['provider_response', 'provider_invoice', 'billing_correction'].includes(evidence.kind), 'Priced actual usage requires billing evidence');
  }

  private appendEvidence(evidence: UsageEvidence, now: Date): void {
    assertDate(now, 'Accounting update time');
    const observedAt = new Date(evidence.observedAt);
    invariant(observedAt >= this.lastEvidenceAt && observedAt <= now, 'Accounting evidence must be current and observed by update time');
    invariant(this.evidence.length < 64, 'Accounting evidence history requires archival before further updates');
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    this.evidence = [...this.evidence, copyJson(evidence)];
    this.lastEvidenceAt = observedAt;
    this.rowRevision += 1;
    this.updatedAt = new Date(now);
  }
}
