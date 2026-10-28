/** Read operator-owned rules, spending limits and retention separately from runtime secrets. */
import { open } from 'node:fs/promises';
import { copyJson, invariant } from '../db/entity-values.js';
import { assertExactMoney } from '../usage/entities/usage-reservation.entity.js';
import type { ModerationPolicyRevisionInput } from '../../contexts/moderation/entities/moderation-policy-revision.entity.js';

export type ModerationPolicyConfiguration = Pick<ModerationPolicyRevisionInput,
  'rules' | 'requiredEvidence' | 'exclusions' | 'evaluationConfiguration' | 'actionMapping'>;

export interface ProviderPrice {
  provider: 'deepseek' | 'openrouter';
  model: string;
  version: string;
  currency: string;
  inputPerMillion: string;
  outputPerMillion: string;
  /** Conservative ceiling, including all prompts, before the actual tokenizer is known. */
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface YunaPolicyConfig {
  schemaVersion: 1;
  /** Availability never substitutes for a member's explicit consent to memory or a debate. */
  features?: { memory: boolean; debates: boolean };
  usage: {
    dailyAttemptLimit: number;
    /** Null preserves the pilot's explicit attempt-only limit, not a monetary guarantee. */
    dailyBudget: { amount: string; currency: string } | null;
    prices: ProviderPrice[];
    /** Defaults for each member's requested AI work; moderation is charged to the guild. */
    userDefaults?: { dailyAttemptLimit: number; dailyBudget: { amount: string; currency: string } | null };
  };
  moderation: { enabled: boolean; policy: ModerationPolicyConfiguration | null };
  retention: { payloadDays: number; metadataDays: number; evidenceDays: number; accountingDays: number };
}

export const defaultYunaPolicy: Readonly<YunaPolicyConfig> = {
  schemaVersion: 1,
  usage: { dailyAttemptLimit: 20, dailyBudget: null, prices: [] },
  moderation: { enabled: false, policy: null },
  retention: { payloadDays: 1, metadataDays: 7, evidenceDays: 30, accountingDays: 30 },
};

/** Reject misspelled settings and malformed rules before any runtime configuration is applied. */
export function validatePolicyConfig(value: unknown): YunaPolicyConfig {
  const config = copyJson(value) as YunaPolicyConfig;
  try {
    invariant(config !== null && typeof config === 'object' && !Array.isArray(config)
      && config.schemaVersion === 1, 'schemaVersion');
    invariant(Object.keys(config).every(key => ['schemaVersion', 'usage', 'moderation', 'retention', 'features'].includes(key)), 'fields');
    if (config.features !== undefined) invariant(config.features && Object.keys(config.features).length === 2
      && typeof config.features.memory === 'boolean' && typeof config.features.debates === 'boolean', 'features');
    const { usage, moderation, retention } = config;
    invariant(usage && typeof usage === 'object'
      && Object.keys(usage).every(key => ['dailyAttemptLimit', 'dailyBudget', 'prices', 'userDefaults'].includes(key)), 'usage');
    invariant(Number.isInteger(usage.dailyAttemptLimit) && usage.dailyAttemptLimit >= 1 && usage.dailyAttemptLimit <= 1_000_000, 'dailyAttemptLimit');
    invariant(usage.dailyBudget === null || (typeof usage.dailyBudget === 'object'
      && Object.keys(usage.dailyBudget).every(key => ['amount', 'currency'].includes(key))), 'dailyBudget');
    if (usage.dailyBudget !== null) assertExactMoney(usage.dailyBudget);
    if (usage.userDefaults !== undefined) {
      const user = usage.userDefaults;
      invariant(user && Object.keys(user).every(key => ['dailyAttemptLimit', 'dailyBudget'].includes(key))
        && Number.isInteger(user.dailyAttemptLimit) && user.dailyAttemptLimit >= 0 && user.dailyAttemptLimit <= usage.dailyAttemptLimit,
      'user defaults');
      if (user.dailyBudget !== null) {
        assertExactMoney(user.dailyBudget);
        invariant(!usage.dailyBudget || user.dailyBudget.currency === usage.dailyBudget.currency, 'user currency');
      }
    }
    invariant(Array.isArray(usage.prices) && usage.prices.length <= 32, 'prices');
    const identities = new Set<string>();
    for (const price of usage.prices) {
      invariant(price && typeof price === 'object' && Object.keys(price).every(key => ['provider', 'model', 'version', 'currency',
        'inputPerMillion', 'outputPerMillion', 'maxInputTokens', 'maxOutputTokens'].includes(key)), 'price');
      invariant(['deepseek', 'openrouter'].includes(price.provider), 'provider');
      for (const field of [price.model, price.version]) invariant(typeof field === 'string' && /^[^\s\p{Cc}]{1,512}$/u.test(field), 'price identity');
      const identity = `${price.provider}:${price.model}`;
      invariant(!identities.has(identity), 'duplicate price'); identities.add(identity);
      assertExactMoney({ amount: price.inputPerMillion, currency: price.currency });
      assertExactMoney({ amount: price.outputPerMillion, currency: price.currency });
      invariant(!usage.dailyBudget || usage.dailyBudget.currency === price.currency, 'price currency');
      invariant(!usage.userDefaults?.dailyBudget || usage.userDefaults.dailyBudget.currency === price.currency, 'member price currency');
      invariant(Number.isSafeInteger(price.maxInputTokens) && price.maxInputTokens >= 1 && price.maxInputTokens <= 128_000, 'maxInputTokens');
      invariant(Number.isSafeInteger(price.maxOutputTokens) && price.maxOutputTokens >= 1 && price.maxOutputTokens <= 4_096, 'maxOutputTokens');
    }
    invariant(moderation && typeof moderation === 'object' && typeof moderation.enabled === 'boolean'
      && Object.keys(moderation).every(key => ['enabled', 'policy'].includes(key)), 'moderation');
    invariant(moderation.policy === null || (typeof moderation.policy === 'object' && !Array.isArray(moderation.policy)), 'moderation policy');
    invariant(!moderation.enabled || moderation.policy !== null, 'enabled policy');
    if (moderation.policy) {
      const policy = moderation.policy;
      invariant(Object.keys(policy).every(key => ['rules', 'requiredEvidence', 'exclusions', 'evaluationConfiguration', 'actionMapping'].includes(key)), 'policy fields');
      invariant(Array.isArray(policy.rules) && policy.rules.length >= 1 && policy.rules.length <= 100, 'rules');
      const ids = new Set<string>();
      for (const rule of policy.rules) {
        invariant(rule && typeof rule === 'object' && typeof rule.id === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(rule.id)
          && !ids.has(rule.id) && typeof rule.enabled === 'boolean', 'rule identity'); ids.add(rule.id);
        invariant(typeof rule.version === 'string' && rule.version.length > 0 && rule.version.length <= 128
          && typeof rule.description === 'string' && rule.description.length > 0 && rule.description.length <= 4_000, 'rule content');
      }
      invariant(Array.isArray(policy.requiredEvidence) && policy.requiredEvidence.length === ids.size, 'evidence requirements');
      const required = new Set<string>();
      for (const item of policy.requiredEvidence) {
        invariant(ids.has(item.ruleId) && !required.has(item.ruleId) && typeof item.originalBody === 'boolean'
          && typeof item.originalMedia === 'boolean' && typeof item.establishedAuthor === 'boolean', 'evidence');
        required.add(item.ruleId);
      }
      invariant(Array.isArray(policy.exclusions) && policy.exclusions.length <= 100, 'exclusions');
      for (const item of policy.exclusions) invariant(typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 64
        && typeof item.description === 'string' && item.description.length > 0 && item.description.length <= 4_000
        && Array.isArray(item.ruleIds) && item.ruleIds.length > 0 && item.ruleIds.every(id => ids.has(id)), 'exclusion');
      const evaluation = policy.evaluationConfiguration;
      invariant(evaluation?.schemaVersion === 1, 'evaluation');
      const thresholds = evaluation.decisionThresholds;
      invariant(!moderation.enabled || thresholds !== undefined, 'enabled moderation thresholds');
      if (thresholds !== undefined) invariant(Object.keys(thresholds).length === 3
        && Number.isFinite(thresholds.minimumConfidence) && thresholds.minimumConfidence > 0.5 && thresholds.minimumConfidence <= 1
        && Number.isFinite(thresholds.yesThreshold) && thresholds.yesThreshold > 0.5 && thresholds.yesThreshold <= 1
        && Number.isFinite(thresholds.noThreshold) && thresholds.noThreshold >= 0 && thresholds.noThreshold < 0.5, 'decision thresholds');
      for (const item of [evaluation.observationModel, evaluation.assessmentModel, evaluation.promptVersion]) {
        invariant(typeof item === 'string' && /^[^\s\p{Cc}]{1,512}$/u.test(item), 'evaluation identity');
      }
      invariant(Array.isArray(policy.actionMapping) && policy.actionMapping.length <= 200, 'actionMapping');
      const mappings = new Set<string>();
      for (const mapping of policy.actionMapping) {
        const key = `${mapping.ruleId}:${mapping.supportedDisposition}`;
        invariant(ids.has(mapping.ruleId) && !mappings.has(key) && ['violation', 'suspicion'].includes(mapping.supportedDisposition)
          && ['ban', 'warning', 'none'].includes(mapping.action), 'action mapping'); mappings.add(key);
        invariant(Number.isInteger(mapping.deleteMessageSeconds) && mapping.deleteMessageSeconds >= 0 && mapping.deleteMessageSeconds <= 604_800
          && (mapping.action === 'ban' || mapping.deleteMessageSeconds === 0)
          && (mapping.action !== 'ban' || mapping.supportedDisposition === 'violation'), 'action limits');
      }
    }
    invariant(retention && typeof retention === 'object' && Object.keys(retention).length === 4, 'retention');
    for (const key of ['payloadDays', 'metadataDays', 'evidenceDays', 'accountingDays'] as const) {
      invariant(Number.isInteger(retention[key]) && retention[key] >= 1 && retention[key] <= 3650, `retention.${key}`);
    }
    invariant(retention.metadataDays >= retention.payloadDays, 'metadata retention');
    return config;
  } catch { throw new Error('Invalid Yuna policy configuration; check rules, budgets and retention fields'); }
}

/** Load at most 128 KiB from a selected regular file; failures never echo its content or path. */
export async function loadPolicyConfig(path?: string, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<YunaPolicyConfig> {
  if (path === undefined) return validatePolicyConfig(defaultYunaPolicy);
  let handle;
  try {
    handle = await open(path, 'r');
    const metadata = await handle.stat();
    invariant(metadata.isFile() && metadata.size <= 128 * 1024, 'policy file size');
    const buffer = Buffer.alloc(128 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    invariant(size <= 128 * 1024, 'policy file size');
    const config = validatePolicyConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))));
    // Only these two nonsecret model selectors support substitution; arbitrary file text never reads environment secrets.
    const evaluation = config.moderation.policy?.evaluationConfiguration;
    if (evaluation) for (const [field, variable] of [['observationModel', 'REPLY_MODEL'], ['assessmentModel', 'JEV_MODEL']] as const) {
      if (evaluation[field] === `env:${variable}`) {
        const selected = environment[variable];
        invariant(typeof selected === 'string' && /^[^\s\p{Cc}]{1,512}$/u.test(selected), 'Missing policy model selector');
        evaluation[field] = selected;
      }
    }
    return validatePolicyConfig(config);
  } catch { throw new Error('Unable to load valid Yuna policy configuration'); }
  finally { await handle?.close(); }
}
