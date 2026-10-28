/** Let members inspect and lower their own UTC-day usage limits without granting access to another member's spending. */
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { assertDiscordId, assertUuid, invariant } from '../db/entity-values.js';
import { assertExactMoney, type ExactMoney } from './entities/usage-reservation.entity.js';
import type { TrustedCallerContext } from '../../contexts/administration/contracts.js';
import type { InstallationScope } from '../../contexts/administration/guild-lifecycle.service.js';
import { defaultYunaPolicy, validatePolicyConfig, type YunaPolicyConfig } from '../config/policy-config.js';

export interface UserUsageStatus {
  windowStart: string; windowEnd: string; attemptsUsed: number; attemptLimit: number; attemptsRemaining: number;
  dailyBudget: ExactMoney | null; committedAmount: string | null; unknownCostAttempts: number;
  blockedReason: 'personal_currency_mismatch' | null;
  personalLimit: { dailyAttemptLimit: number | null; dailyBudget: ExactMoney | null } | null;
}
type PersonalLimit = { dailyAttemptLimit?: number; dailyBudget?: ExactMoney };
type StoredLimit = { daily_attempt_limit: number | null; daily_budget: string | null; currency: string | null };

export class UserUsageService {
  /** Scope comes from the running installation; Discord supplies only the authenticated caller identity. */
  constructor(private readonly orm: MikroORM, private readonly scope: InstallationScope) {}

  /** Read only this caller's totals; an unknown price is shown explicitly rather than presented as zero spend. */
  async readStatus(caller: TrustedCallerContext): Promise<UserUsageStatus> {
    caller = Object.freeze({ ...caller });
    this.validateCaller(caller);
    return this.orm.em.fork().transactional(async em => {
      const config = await this.lockPolicy(em);
      return this.status(em, caller.actorId, config);
    });
  }

  /** Save a member's stricter preference; the claim gate still applies every server-wide and default member cap. */
  async setLimit(caller: TrustedCallerContext, input: PersonalLimit): Promise<UserUsageStatus> {
    caller = Object.freeze({ ...caller });
    this.validateCaller(caller);
    invariant(input && Object.keys(input).length > 0 && Object.keys(input).every(key => ['dailyAttemptLimit', 'dailyBudget'].includes(key)), 'Invalid personal limit');
    const change: PersonalLimit = {};
    if (input.dailyAttemptLimit !== undefined) {
      invariant(Number.isInteger(input.dailyAttemptLimit) && input.dailyAttemptLimit >= 0 && input.dailyAttemptLimit <= 1_000_000, 'Invalid personal attempt limit');
      change.dailyAttemptLimit = input.dailyAttemptLimit;
    }
    if (input.dailyBudget !== undefined) { assertExactMoney(input.dailyBudget); change.dailyBudget = { ...input.dailyBudget }; }
    invariant(Object.keys(change).length > 0, 'An actual personal limit is required');
    return this.orm.em.fork().transactional(async em => {
      const config = await this.lockPolicy(em);
      const expectedCurrency = config.usage.userDefaults?.dailyBudget?.currency ?? config.usage.dailyBudget?.currency;
      invariant(!change.dailyBudget || !expectedCurrency || change.dailyBudget.currency === expectedCurrency, 'Personal budget currency must match the server');
      // This is the same first budget lock as provider claims, so a racing change has one clear before/after ordering.
      await em.execute("select pg_advisory_xact_lock(hashtextextended('yuna:attempts:day:'||?||':'||to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD'),0))", [this.scope.guildId]);
      await em.execute(`insert into public.user_usage_limit(guild_id,user_id,installation_id,daily_attempt_limit,daily_budget,currency,updated_at)
        values(?,?,?,?,?,?,clock_timestamp()) on conflict(guild_id,user_id) do update set installation_id=excluded.installation_id,
        daily_attempt_limit=case when ? then excluded.daily_attempt_limit else user_usage_limit.daily_attempt_limit end,
        daily_budget=case when ? then excluded.daily_budget else user_usage_limit.daily_budget end,
        currency=case when ? then excluded.currency else user_usage_limit.currency end,updated_at=excluded.updated_at`,
      [this.scope.guildId, caller.actorId, this.scope.installationId, change.dailyAttemptLimit ?? null,
        change.dailyBudget?.amount ?? null, change.dailyBudget?.currency ?? null, change.dailyAttemptLimit !== undefined,
        change.dailyBudget !== undefined, change.dailyBudget !== undefined]);
      return this.status(em, caller.actorId, config);
    });
  }

  /** Remove only this member's preference; server defaults and reservations already made remain in force. */
  async clearLimit(caller: TrustedCallerContext): Promise<UserUsageStatus> {
    caller = Object.freeze({ ...caller });
    this.validateCaller(caller);
    return this.orm.em.fork().transactional(async em => {
      const config = await this.lockPolicy(em);
      await em.execute("select pg_advisory_xact_lock(hashtextextended('yuna:attempts:day:'||?||':'||to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD'),0))", [this.scope.guildId]);
      await em.execute('delete from public.user_usage_limit where guild_id=? and user_id=?', [this.scope.guildId, caller.actorId]);
      return this.status(em, caller.actorId, config);
    });
  }

  /** Erase this installation's personal preferences during removal; accounting follows its separate retention contract. */
  async cleanupForRemoval(em: EntityManager): Promise<{ status: 'complete'; reason: string }> {
    invariant(em.isInTransaction(), 'Removal cleanup requires the owner transaction');
    await em.execute('delete from public.user_usage_limit where installation_id=? and guild_id=?', [this.scope.installationId, this.scope.guildId]);
    return { status: 'complete', reason: 'personal_preferences_erased' };
  }

  /** IDs are checked even for internal callers; command arguments never select a different actor or installation. */
  private validateCaller(caller: TrustedCallerContext): void {
    assertUuid(caller.installationId); assertDiscordId(caller.guildId); assertDiscordId(caller.actorId);
    invariant(caller.installationId === this.scope.installationId && caller.guildId === this.scope.guildId, 'Usage request scope mismatch');
  }

  /** Share the installation lock order with claim/configuration, including while ordinary work is paused. */
  private async lockPolicy(em: EntityManager): Promise<YunaPolicyConfig> {
    const rows = await em.execute<{ state: string; operator_policy: unknown }[]>(
      'select state,operator_policy from public.guild_installation where id=? and guild_id=? for update', [this.scope.installationId, this.scope.guildId]);
    invariant(rows[0]?.state === 'active', 'Usage settings require an active installation');
    return validatePolicyConfig(rows[0].operator_policy ?? defaultYunaPolicy);
  }

  /** PostgreSQL computes decimal sums and minima; JavaScript formats strings without rounding money. */
  private async status(em: EntityManager, actorId: string, config: YunaPolicyConfig): Promise<UserUsageStatus> {
    const personal = (await em.execute<StoredLimit[]>('select daily_attempt_limit,daily_budget::text,currency from public.user_usage_limit where guild_id=? and user_id=?', [this.scope.guildId, actorId]))[0];
    const defaults = config.usage.userDefaults;
    const attempts = Math.min(config.usage.dailyAttemptLimit, defaults?.dailyAttemptLimit ?? Infinity, personal?.daily_attempt_limit ?? Infinity);
    const serverBudget = defaults?.dailyBudget ?? config.usage.dailyBudget;
    const budget = serverBudget ?? (personal?.daily_budget && personal.currency ? { amount: personal.daily_budget, currency: personal.currency } : null);
    const incompatibleCurrency = Boolean(personal?.currency && serverBudget && personal.currency !== serverBudget.currency);
    const rows = await em.execute<{ start_at: Date; end_at: Date; used: number; unknown: number; committed: string; budget: string | null }[]>(`
      with day as(select date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC' as start_at),
      charges as(select u.*,e.actual_cost from public.usage_reservation u left join public.usage_entry e on e.reservation_id=u.id,day
        where u.guild_id=? and u.policy_snapshot->>'userId'=? and u.reserved_at>=day.start_at and u.reserved_at<day.start_at+interval '1 day')
      select day.start_at,day.start_at+interval '1 day' as end_at,(select count(*)::integer from charges) as used,
      (select count(*)::integer from charges where state<>'released' and
        ((state in ('reserved','liability') and pricing_version='unpriced-bounded-units-v1') or currency<>coalesce(?,currency))) as unknown,
      (select coalesce(sum(case when state='released' then 0 when state='settled' then coalesce(actual_cost,reserved_cost) else reserved_cost end),0)::text from charges) as committed,
      least(?::numeric,?::numeric,?::numeric)::text as budget from day`,
    [this.scope.guildId, actorId, budget?.currency ?? null, serverBudget?.amount ?? null, config.usage.dailyBudget?.amount ?? null, personal?.daily_budget ?? null]);
    const row = rows[0]!;
    return { windowStart: new Date(row.start_at).toISOString(), windowEnd: new Date(row.end_at).toISOString(), attemptsUsed: row.used,
      attemptLimit: attempts, attemptsRemaining: Math.max(0, attempts - row.used), dailyBudget: !incompatibleCurrency && budget && row.budget !== null ? { amount: row.budget, currency: budget.currency } : null,
      committedAmount: row.unknown > 0 ? null : row.committed, unknownCostAttempts: row.unknown,
      blockedReason: incompatibleCurrency ? 'personal_currency_mismatch' : null,
      personalLimit: personal ? { dailyAttemptLimit: personal.daily_attempt_limit,
        dailyBudget: personal.daily_budget !== null && personal.currency ? { amount: personal.daily_budget, currency: personal.currency } : null } : null };
  }
}
