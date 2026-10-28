/** Prepare authorized setup outside transactions, then let ConfigurationService persist the exact captured policy. */
import { createAutonomousModerationPolicy } from '../../src/platform/config/autonomous-moderation.js';
import { validatePolicyConfig, type YunaPolicyConfig } from '../../src/platform/config/policy-config.js';
import { validateServerRules, type ServerRulesSnapshot } from '../../src/platform/config/server-rules.js';
import { invariant } from '../../src/platform/db/entity-values.js';

export interface PreparedServerConfiguration {
  config: YunaPolicyConfig;
  rules: { count: number; coverage: ServerRulesSnapshot['coverage'] } | null;
}

/** Owner setup selects the built-in preset; configure refreshes guidance while preserving chosen limits and feature settings. */
export async function prepareServerConfiguration(value: YunaPolicyConfig, options: {
  autonomous: boolean; guildId: string; observationModel: string; assessmentModel?: string;
  readRules: () => Promise<ServerRulesSnapshot>;
}): Promise<PreparedServerConfiguration> {
  const config = validatePolicyConfig(value);
  if (options.autonomous) {
    invariant(options.assessmentModel, 'Automatic moderation requires an assessment model');
    config.moderation = { enabled: true, policy: createAutonomousModerationPolicy(options.observationModel, options.assessmentModel) };
  }
  if (!config.moderation.enabled) return { config, rules: null };
  invariant(options.assessmentModel && config.moderation.policy, 'Moderation requires an assessment route');
  const snapshot = await options.readRules();
  validateServerRules(snapshot);
  invariant(snapshot.guildId === options.guildId && snapshot.coverage !== 'unavailable'
    && (snapshot.coverage !== 'partial' || snapshot.sources.length > 0), 'Server rules could not be read; keep the previous configuration');
  config.moderation.policy.evaluationConfiguration.serverRules = structuredClone(snapshot);
  return { config: validatePolicyConfig(config), rules: { count: snapshot.sources.length, coverage: snapshot.coverage } };
}
