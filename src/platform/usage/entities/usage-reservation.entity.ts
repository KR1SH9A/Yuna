import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertNonNegativeInteger, assertUuid, copyJson, invariant, type JsonObject, type ScopedEntityInput } from '../../db/entity-values.js';

export interface ExactMoney { amount: string; currency: string }
export interface UsageUnits { [unit: string]: number }
export type UsageOperationKind = 'task-attempt' | 'explicit-operation';
export interface ResolvedBudgetWindow { key: string; startsAt: string; endsAt: string }
export interface UsageEvidence {
  kind: 'provider_response' | 'provider_invoice' | 'confirmed_no_dispatch' | 'provider_no_spend' | 'billing_correction' | 'timeout' | 'lease_expired';
  reference: string;
  observedAt: string;
}

/** Decimal strings avoid rounding money through JS numbers or PostgreSQL float columns. */
export function assertExactMoney(value: ExactMoney): void {
  invariant(typeof value.amount === 'string' && /^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/.test(value.amount), 'Cost must be a nonnegative exact decimal string (20 integer/18 fractional digits)');
  invariant(/^[A-Z]{3}$/.test(value.currency), 'Cost requires a three-letter currency');
}

export function assertUsageUnits(units: UsageUnits): void {
  invariant(Object.keys(units).length <= 32, 'Usage must have a bounded set of unit kinds');
  for (const [name, amount] of Object.entries(units)) {
    invariant(/^[a-z][a-z0-9_]{0,63}$/.test(name), 'Usage unit name is invalid');
    assertNonNegativeInteger(amount, `Usage unit ${name}`);
  }
}

export function assertUsageEvidence(evidence: UsageEvidence): void {
  invariant(['provider_response', 'provider_invoice', 'confirmed_no_dispatch', 'provider_no_spend', 'billing_correction', 'timeout', 'lease_expired'].includes(evidence.kind), 'Unknown accounting evidence kind');
  invariant(evidence.reference.length > 0 && evidence.reference.length <= 512, 'Accounting evidence requires a bounded reference');
  invariant(typeof evidence.observedAt === 'string', 'Evidence timestamp must be serialized');
  assertDate(new Date(evidence.observedAt), 'Evidence observation time');
}

export function isNoSpendEvidence(evidence: UsageEvidence): boolean {
  return evidence.kind === 'confirmed_no_dispatch' || evidence.kind === 'provider_no_spend';
}

export interface UsageReservationInput extends ScopedEntityInput {
  feature: string;
  provider: string;
  modelRoute: string;
  operationKind: UsageOperationKind;
  operationKey: string;
  taskId?: string;
  attemptNumber?: number;
  reservedUnits: UsageUnits;
  reservedCost: ExactMoney;
  usagePolicyId: string;
  policyRevision: number;
  policySnapshot: JsonObject;
  pricingVersion: string;
  budgetWindows: ResolvedBudgetWindow[];
  reconcileAfter: Date;
  purgeAfter: Date;
}

/** Admission snapshot and unresolved capacity; budget locking belongs to UsageService. */
@Entity({ tableName: 'usage_reservation' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'operationKind', 'operationKey'] })
@Unique({ properties: ['installationId', 'taskId', 'attemptNumber'] })
@Unique({ properties: ['attemptId'] })
@Index({ properties: ['state', 'reconcileAfter'] })
@Index({ properties: ['guildId', 'provider', 'state'] })
@Check({ name: 'usage_reservation_check_1', expression: "operation_kind in ('task-attempt', 'explicit-operation') and state in ('reserved', 'liability', 'settled', 'released')" })
@Check({ name: 'usage_reservation_check_2', expression: "(operation_kind = 'task-attempt' and task_id is not null and attempt_number is not null and attempt_number > 0) or (operation_kind = 'explicit-operation' and task_id is null and attempt_number is null and attempt_id is null)" })
@Check({ name: 'usage_reservation_check_3', expression: 'reserved_cost >= 0 and policy_revision >= 0' })
@Check({ name: 'usage_reservation_check_4', expression: "state <> 'settled' or settled_at is not null" })
@Check({ name: 'usage_reservation_check_5', expression: "state <> 'released' or released_at is not null" })
export class UsageReservation extends ScopedEntity {
  @Property({ type: 'text' }) readonly feature: string;
  @Property({ type: 'text' }) readonly provider: string;
  @Property({ type: 'text' }) readonly modelRoute: string;
  @Property({ type: 'text' }) readonly operationKind: UsageOperationKind;
  @Property({ type: 'text' }) readonly operationKey: string;
  @Property({ type: 'uuid', nullable: true }) readonly taskId: string | null;
  @Property({ type: 'integer', nullable: true }) readonly attemptNumber: number | null;
  @Property({ type: 'uuid', nullable: true }) attemptId: string | null = null;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly reservedUnits: UsageUnits;
  @Property({ type: 'decimal', columnType: 'numeric(38,18)' }) readonly reservedCost: string;
  @Property({ type: 'text' }) readonly currency: string;
  @Property({ type: 'uuid' }) readonly usagePolicyId: string;
  @Property({ type: 'integer' }) readonly policyRevision: number;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly policySnapshot: JsonObject;
  @Property({ type: 'text' }) readonly pricingVersion: string;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly budgetWindows: ResolvedBudgetWindow[];
  @Property({ type: 'text' }) state: 'reserved' | 'liability' | 'settled' | 'released' = 'reserved';
  @Property({ type: 'datetime', columnType: 'timestamptz' }) readonly reservedAt: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) reconcileAfter: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) releasedAt: Date | null = null;
  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true }) settledAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) resolutionReason: string | null = null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) resolutionEvidence: UsageEvidence | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: 'datetime', columnType: 'timestamptz' }) readonly purgeAfter: Date;

  constructor(input: UsageReservationInput) {
    super(input);
    for (const value of [input.feature, input.provider, input.modelRoute, input.operationKey, input.pricingVersion]) invariant(value.length > 0 && value.length <= 512, 'Reservation identifiers must be bounded and nonempty');
    invariant(input.operationKind === 'task-attempt' || input.operationKind === 'explicit-operation', 'Unknown reserved operation kind');
    if (input.operationKind === 'task-attempt') {
      invariant(input.taskId !== undefined && input.attemptNumber !== undefined, 'Task reservations require a task and attempt slot');
      assertUuid(input.taskId);
      assertNonNegativeInteger(input.attemptNumber, 'Reserved attempt number');
      invariant(input.attemptNumber > 0 && input.attemptNumber <= 2_147_483_647, 'Attempt number must fit a positive PostgreSQL integer');
    } else invariant(input.taskId === undefined && input.attemptNumber === undefined, 'Explicit operations cannot carry task-attempt slots');
    assertUsageUnits(input.reservedUnits);
    assertExactMoney(input.reservedCost);
    assertUuid(input.usagePolicyId);
    assertNonNegativeInteger(input.policyRevision, 'Policy revision');
    invariant(input.policyRevision <= 2_147_483_647, 'Policy revision exceeds PostgreSQL integer');
    invariant(input.budgetWindows.length > 0 && input.budgetWindows.length <= 32, 'A bounded set of resolved budget windows is required');
    const keys = new Set<string>();
    for (const window of input.budgetWindows) {
      invariant(window.key.length > 0 && window.key.length <= 256 && !keys.has(window.key), 'Budget window keys must be bounded and unique');
      keys.add(window.key);
      const start = new Date(window.startsAt);
      const end = new Date(window.endsAt);
      assertDate(start, 'Budget window start');
      assertDate(end, 'Budget window end');
      invariant(start < end && start <= this.createdAt && this.createdAt < end, 'Resolved budget windows must contain reservation time');
    }
    assertDate(input.reconcileAfter, 'Reconciliation due time');
    assertDate(input.purgeAfter, 'Accounting retention deadline');
    invariant(input.reconcileAfter >= this.createdAt && input.purgeAfter > this.createdAt, 'Accounting deadlines cannot precede admission');
    this.feature = input.feature;
    this.provider = input.provider;
    this.modelRoute = input.modelRoute;
    this.operationKind = input.operationKind;
    this.operationKey = input.operationKey;
    this.taskId = input.taskId ?? null;
    this.attemptNumber = input.attemptNumber ?? null;
    this.reservedUnits = copyJson(input.reservedUnits);
    this.reservedCost = input.reservedCost.amount;
    this.currency = input.reservedCost.currency;
    this.usagePolicyId = input.usagePolicyId;
    this.policyRevision = input.policyRevision;
    this.policySnapshot = copyJson(input.policySnapshot);
    this.pricingVersion = input.pricingVersion;
    this.budgetWindows = copyJson(input.budgetWindows);
    this.reservedAt = new Date(this.createdAt);
    this.reconcileAfter = new Date(input.reconcileAfter);
    this.updatedAt = new Date(this.createdAt);
    this.purgeAfter = new Date(input.purgeAfter);
  }

  bindAttempt(attemptId: string, now: Date): void {
    assertUuid(attemptId);
    invariant(this.operationKind === 'task-attempt' && this.state === 'reserved', 'Only a reserved task slot can be claimed');
    if (this.attemptId === attemptId) return;
    invariant(this.attemptId === null, 'A reservation cannot be reassigned to another attempt');
    this.advanceRevision(now);
    this.attemptId = attemptId;
  }

  /** No automatic refund: timeouts, cancellation and lost leases retain possible spend. */
  markLiability(evidence: UsageEvidence, reconcileAfter: Date, now: Date): void {
    invariant(this.state === 'reserved' || this.state === 'liability', 'Resolved capacity cannot become uncertain again');
    assertUsageEvidence(evidence);
    assertDate(reconcileAfter, 'Reconciliation due time');
    invariant(reconcileAfter > now, 'Unresolved liability requires future reconciliation');
    this.advanceRevision(now);
    this.state = 'liability';
    this.resolutionReason = evidence.kind;
    this.resolutionEvidence = copyJson(evidence);
    this.reconcileAfter = new Date(reconcileAfter);
  }

  /** Persist the corresponding actual UsageEntry atomically; actual cost may exceed this estimate. */
  settle(evidence: UsageEvidence, now: Date): void {
    assertUsageEvidence(evidence);
    const correction = evidence.kind === 'billing_correction' && this.resolutionEvidence !== null && new Date(evidence.observedAt) > new Date(this.resolutionEvidence.observedAt);
    invariant(this.state === 'reserved' || this.state === 'liability' || correction, 'Resolved capacity requires newer billing correction evidence');
    invariant(evidence.kind === 'provider_response' || evidence.kind === 'provider_invoice' || evidence.kind === 'billing_correction', 'Settlement requires actual billing evidence');
    this.advanceRevision(now);
    this.state = 'settled';
    this.settledAt = new Date(now);
    this.resolutionReason = evidence.kind;
    this.resolutionEvidence = copyJson(evidence);
  }

  releaseUnused(evidence: UsageEvidence, now: Date): void {
    invariant(this.state === 'reserved' || this.state === 'liability', 'Reservation is already resolved');
    assertUsageEvidence(evidence);
    invariant(isNoSpendEvidence(evidence), 'Release requires positive no-spend evidence, not timeout or lease expiry');
    this.advanceRevision(now);
    this.state = 'released';
    this.releasedAt = new Date(now);
    this.resolutionReason = evidence.kind;
    this.resolutionEvidence = copyJson(evidence);
  }

  canPurge(now: Date): boolean {
    assertDate(now, 'Retention time');
    return (this.state === 'settled' || this.state === 'released') && now >= this.purgeAfter;
  }

  private advanceRevision(now: Date): void {
    assertDate(now, 'Accounting update time');
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    this.rowRevision += 1;
    this.updatedAt = new Date(now);
  }
}
