import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface BudgetLimit {
  budgetKey: string;
  feature: string;
  provider: string;
  allowance: { mode: 'disabled' | 'unlimited' } | { mode: 'limited'; amount: string; currency: string };
}
export interface BudgetWindowRule { budgetKey: string; durationSeconds: number }
export interface AttemptBound { provider: string; modelRoute: string; maxUnits: number; maxCost: string; currency: string }
export interface UsagePolicyConfiguration {
  schemaVersion: 1;
  limits: readonly BudgetLimit[];
  windowRules: readonly BudgetWindowRule[];
  perAttemptBounds: readonly AttemptBound[];
}
export interface UsagePolicyInput extends ScopedEntityInput {
  configuration: UsagePolicyConfiguration;
  effectiveAt: Date;
  updatedBy: { kind: 'user'; userId: string } | { kind: 'system'; operation: string };
}

function validateConfiguration(value: UsagePolicyConfiguration): void {
  invariant(value.schemaVersion === 1, 'Unsupported usage policy schema');
  invariant(new Set(value.limits.map(limit => limit.budgetKey)).size === value.limits.length, 'Duplicate budget key');
  invariant(new Set(value.windowRules.map(rule => rule.budgetKey)).size === value.windowRules.length, 'Duplicate window key');
  for (const limit of value.limits) {
    invariant(limit.budgetKey.length > 0 && limit.provider.length > 0 && limit.feature.length > 0, 'Budget identity is required');
    invariant(value.windowRules.some(rule => rule.budgetKey === limit.budgetKey), 'Budget window is missing');
    if (limit.allowance.mode === 'limited') invariant(/^\d+(?:\.\d+)?$/.test(limit.allowance.amount) && limit.allowance.currency.length > 0, 'Invalid exact budget amount');
  }
  for (const rule of value.windowRules) {
    assertNonNegativeInteger(rule.durationSeconds, 'durationSeconds');
    invariant(rule.durationSeconds > 0 && value.limits.some(limit => limit.budgetKey === rule.budgetKey), 'Invalid budget window');
  }
  for (const bound of value.perAttemptBounds) {
    assertNonNegativeInteger(bound.maxUnits, 'maxUnits');
    invariant(/^\d+(?:\.\d+)?$/.test(bound.maxCost) && bound.currency.length > 0, 'Invalid exact attempt ceiling');
  }
}

/** Reservations copy this policy; revising it never rewrites admitted liabilities. */
@Entity({ tableName: 'usage_policy' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId'] })
@Check({ name: 'usage_policy_check_1', expression: '"policy_revision" >= 0' })
@Check({ name: 'usage_policy_check_2', expression: '"row_revision" >= 1' })
export class UsagePolicy extends ScopedEntity {
  @Property({ type: 'integer' }) policyRevision = 0;
  @Property({ type: 'integer' }) readonly schemaVersion = 1;
  @Property({ type: 'json' }) limits: readonly BudgetLimit[];
  @Property({ type: 'json' }) windowRules: readonly BudgetWindowRule[];
  @Property({ type: 'json' }) perAttemptBounds: readonly AttemptBound[];
  @Property({ type: Date, columnType: 'timestamptz' }) effectiveAt: Date;
  @Property({ type: 'json' }) updatedBy: UsagePolicyInput['updatedBy'];
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;

  constructor(input: UsagePolicyInput) {
    super(input);
    validateConfiguration(input.configuration);
    assertDate(input.effectiveAt, 'effectiveAt');
    if (input.updatedBy.kind === 'user') assertDiscordId(input.updatedBy.userId);
    this.limits = copyJson(input.configuration.limits);
    this.windowRules = copyJson(input.configuration.windowRules);
    this.perAttemptBounds = copyJson(input.configuration.perAttemptBounds);
    this.effectiveAt = new Date(input.effectiveAt);
    this.updatedBy = copyJson(input.updatedBy);
    this.updatedAt = new Date(input.effectiveAt);
  }

  /** Call under the stable guild/provider/window admission lock, including prior generations. */
  revise(configuration: UsagePolicyConfiguration, expectedRevision: number, actor: UsagePolicyInput['updatedBy'], at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    invariant(expectedRevision === this.policyRevision, 'Stale usage policy revision');
    validateConfiguration(configuration);
    assertDate(at, 'at');
    if (actor.kind === 'user') assertDiscordId(actor.userId);
    invariant(at >= this.effectiveAt, 'Policy effective time cannot move backward');
    invariant(this.policyRevision < 2_147_483_647, 'Policy revision exhausted');
    const copied = copyJson(configuration);
    this.limits = copied.limits;
    this.windowRules = copied.windowRules;
    this.perAttemptBounds = copied.perAttemptBounds;
    this.policyRevision += 1;
    this.effectiveAt = new Date(at);
    this.updatedBy = copyJson(actor);
    this.advanceRevision(at);
  }

  private advanceRevision(at: Date): void {
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }
}
