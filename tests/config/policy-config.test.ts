/** Configuration rejects ambiguous sanctions/money while keeping secrets out of policy errors. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@jest/globals';
import { defaultYunaPolicy, loadPolicyConfig, validatePolicyConfig } from '../../src/platform/config/policy-config.js';

test('default policy has explicit attempt-only limits and disabled moderation; callers get detached values', async () => {
  const config = await loadPolicyConfig();
  expect(config.usage.dailyBudget).toBeNull();
  expect(config.moderation).toEqual({ enabled: false, policy: null });
  config.usage.dailyAttemptLimit = 1;
  expect((await loadPolicyConfig()).usage.dailyAttemptLimit).toBe(20);
});

test.each([
  { schemaVersion: 2 }, { typo: true }, { usage: { ...defaultYunaPolicy.usage, dailyAttemptLimit: 0 } },
  { usage: { ...defaultYunaPolicy.usage, dailyBudget: { amount: 0.1, currency: 'USD' } } },
  { usage: { ...defaultYunaPolicy.usage, dailyBudget: { amount: '-1', currency: 'USD' } } },
  { moderation: { enabled: true, policy: null } },
  { retention: { ...defaultYunaPolicy.retention, metadataDays: 0 } },
])('invalid configuration is rejected without echoing supplied values (%#)', changes => {
  expect(() => validatePolicyConfig({ ...defaultYunaPolicy, ...changes })).toThrow('Invalid Yuna policy configuration');
});

test('prices require exact decimal money, bounded tokens, matching currency and unique model routes', () => {
  const price = { provider: 'deepseek', model: 'configured-model', version: 'operator-price-v1', currency: 'USD',
    inputPerMillion: '0.123456789012345678', outputPerMillion: '1.5', maxInputTokens: 24_000, maxOutputTokens: 512 };
  const config = { ...defaultYunaPolicy, usage: { dailyAttemptLimit: 10, dailyBudget: { amount: '2', currency: 'USD' }, prices: [price] } };
  expect(validatePolicyConfig(config).usage.prices[0]?.inputPerMillion).toBe(price.inputPerMillion);
  expect(() => validatePolicyConfig({ ...config, usage: { ...config.usage, prices: [price, price] } })).toThrow();
  expect(() => validatePolicyConfig({ ...config, usage: { ...config.usage, prices: [{ ...price, currency: 'INR' }] } })).toThrow();
});

test('policy files are bounded regular JSON and errors never contain their supplied contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuna-policy-'));
  try {
    const path = join(directory, 'policy.json');
    await writeFile(path, JSON.stringify(defaultYunaPolicy));
    expect(await loadPolicyConfig(path)).toEqual(defaultYunaPolicy);
    await writeFile(path, '{ secret_value=do-not-log');
    await expect(loadPolicyConfig(path)).rejects.toThrow('Unable to load valid Yuna policy configuration');
    await writeFile(path, 'x'.repeat(128 * 1024 + 1));
    await expect(loadPolicyConfig(path)).rejects.toThrow('Unable to load valid Yuna policy configuration');
    await expect(loadPolicyConfig(directory)).rejects.toThrow('Unable to load valid Yuna policy configuration');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('member defaults allow zero requests, reject invalid caps and enforce currency consistency', () => {
  const config = structuredClone(defaultYunaPolicy);
  config.usage.dailyAttemptLimit = 1000;
  config.usage.userDefaults = { dailyAttemptLimit: 0, dailyBudget: null };
  expect(validatePolicyConfig(config).usage.userDefaults?.dailyAttemptLimit).toBe(0);
  config.usage.userDefaults.dailyAttemptLimit = 1001;
  expect(() => validatePolicyConfig(config)).toThrow();
  config.usage.userDefaults = { dailyAttemptLimit: 10, dailyBudget: { amount: '1', currency: 'INR' } };
  config.usage.dailyBudget = { amount: '5', currency: 'USD' };
  expect(() => validatePolicyConfig(config)).toThrow();
});

test('the starter is portable across model selections and monetary template requires explicit prices', async () => {
  const path = new URL('../../../config/yuna.example.json', import.meta.url).pathname;
  const starter = await loadPolicyConfig(path, { REPLY_MODEL: 'any-compatible-observation-model', JEV_MODEL: 'any-compatible-assessment-model' });
  expect(starter.moderation.policy?.evaluationConfiguration.observationModel).toBe('any-compatible-observation-model');
  expect(starter.moderation.policy?.rules).toHaveLength(4);
  expect(starter.moderation.policy?.actionMapping.every(mapping => mapping.action !== 'ban')).toBe(true);
  expect(starter.usage.userDefaults?.dailyAttemptLimit).toBe(10);
  await expect(loadPolicyConfig(path, { REPLY_MODEL: 'configured-only' })).rejects.toThrow('Unable to load valid Yuna policy configuration');
  const budgeted = await loadPolicyConfig(new URL('../../../config/yuna.budgeted.example.json', import.meta.url).pathname,
    { REPLY_MODEL: 'configured', JEV_MODEL: 'configured-assessment' });
  expect(budgeted.usage.dailyBudget).toEqual({ amount: '5.00', currency: 'USD' });
  expect(budgeted.usage.prices).toEqual([]);
});

test('member monetary limits require compatible price currencies even without a guild money cap', () => {
  const config = structuredClone(defaultYunaPolicy);
  config.usage.userDefaults = { dailyAttemptLimit: 10, dailyBudget: { amount: '1', currency: 'EUR' } };
  config.usage.prices = [{ provider: 'deepseek', model: 'fixture', version: 'v1', currency: 'USD', inputPerMillion: '1', outputPerMillion: '1', maxInputTokens: 65536, maxOutputTokens: 4096 }];
  expect(() => validatePolicyConfig(config)).toThrow('Invalid Yuna policy configuration');
});
