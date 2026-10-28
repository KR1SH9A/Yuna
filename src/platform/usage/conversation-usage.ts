/** Build the existing conversation usage policy from explicit operator settings without inventing prices. */
import { UsagePolicy } from '../../contexts/administration/entities/usage-policy.entity.js';
import { invariant, type ScopedEntityInput } from '../db/entity-values.js';
import type { YunaPolicyConfig } from '../config/policy-config.js';

/**
 * Initial request-count policy. Money remains explicitly unpriced: this does not promise a
 * dollar ceiling. The worker reads the trusted budget key and counts all daily reservations.
 */
export function createConversationUsagePolicy(scope: ScopedEntityInput, now: Date, model: string, dailyAttemptLimit = 20,
  configuredUsage?: YunaPolicyConfig['usage']): UsagePolicy {
  dailyAttemptLimit = configuredUsage?.dailyAttemptLimit ?? dailyAttemptLimit;
  invariant(model.length > 0 && model.length <= 512, 'Conversation policy requires a configured model');
  invariant(Number.isInteger(dailyAttemptLimit) && dailyAttemptLimit >= 1 && dailyAttemptLimit <= 1_000_000, 'Daily attempt cap must be between 1 and 1000000');
  const budgetKey = `conversation.daily-attempts:${dailyAttemptLimit}`;
  return new UsagePolicy({
    ...scope, createdAt: scope.createdAt ?? now, effectiveAt: now,
    updatedBy: { kind: 'system', operation: 'conversation-pilot-bootstrap' },
    configuration: {
      schemaVersion: 1,
      limits: [{ budgetKey, feature: 'community', provider: 'deepseek', allowance: { mode: 'unlimited' } },
        ...(configuredUsage?.dailyBudget ? [{ budgetKey: 'guild.daily-money', feature: '*', provider: '*',
          allowance: { mode: 'limited' as const, ...configuredUsage.dailyBudget } }] : [])],
      windowRules: [{ budgetKey, durationSeconds: 86400 },
        ...(configuredUsage?.dailyBudget ? [{ budgetKey: 'guild.daily-money', durationSeconds: 86400 }] : [])],
      perAttemptBounds: (configuredUsage?.prices ?? []).map(price => {
        // Scale to 18 places using integers; numeric(38,18) in PostgreSQL uses the same precision.
        const input = BigInt(price.inputPerMillion.split('.')[0]! + (price.inputPerMillion.split('.')[1] ?? '').padEnd(18, '0'));
        const output = BigInt(price.outputPerMillion.split('.')[0]! + (price.outputPerMillion.split('.')[1] ?? '').padEnd(18, '0'));
        const scaled = (input * BigInt(price.maxInputTokens) + output * BigInt(price.maxOutputTokens) + 999_999n) / 1_000_000n;
        const digits = scaled.toString().padStart(19, '0');
        return { provider: price.provider, modelRoute: price.model, currency: price.currency,
          maxUnits: price.maxInputTokens + price.maxOutputTokens, maxCost: `${digits.slice(0, -18)}.${digits.slice(-18)}`,
          pricingVersion: price.version, inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion,
          maxInputTokens: price.maxInputTokens, maxOutputTokens: price.maxOutputTokens };
      }),
    },
  });
}
