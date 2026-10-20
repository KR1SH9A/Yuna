import { UsagePolicy } from '../../contexts/administration/entities/usage-policy.entity.js';
import { invariant, type ScopedEntityInput } from '../db/entity-values.js';

/**
 * Initial request-count policy. Money remains explicitly unpriced: this does not promise a
 * dollar ceiling. The worker reads the trusted budget key and counts all daily reservations.
 */
export function createConversationUsagePolicy(scope: ScopedEntityInput, now: Date, model: string, dailyAttemptLimit = 20): UsagePolicy {
  invariant(model.length > 0 && model.length <= 512, 'Conversation policy requires a configured model');
  invariant(Number.isInteger(dailyAttemptLimit) && dailyAttemptLimit >= 1 && dailyAttemptLimit <= 20, 'Daily conversation attempt cap must be between 1 and 20');
  const budgetKey = `conversation.daily-attempts:${dailyAttemptLimit}`;
  return new UsagePolicy({
    ...scope, createdAt: scope.createdAt ?? now, effectiveAt: now,
    updatedBy: { kind: 'system', operation: 'conversation-pilot-bootstrap' },
    configuration: {
      schemaVersion: 1,
      limits: [{ budgetKey, feature: 'community', provider: 'deepseek', allowance: { mode: 'unlimited' } }],
      windowRules: [{ budgetKey, durationSeconds: 86400 }], perAttemptBounds: [],
    },
  });
}
