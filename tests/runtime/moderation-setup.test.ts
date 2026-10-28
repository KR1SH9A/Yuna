/** Setup imports bounded server guidance without per-incident staff actions or caller-authored moderation rules. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from '@jest/globals';
import { prepareServerConfiguration } from '../../apps/bot/moderation-setup.handlers.js';
import { defaultYunaPolicy, validatePolicyConfig } from '../../src/platform/config/policy-config.js';
import { createAutonomousModerationPolicy } from '../../src/platform/config/autonomous-moderation.js';
import { validateServerRules, type ServerRulesSnapshot } from '../../src/platform/config/server-rules.js';

const guildId = '100000000000000001';
/** A trusted rules-channel snapshot remains quoted data with exact content hashes. */
function guidance(): ServerRulesSnapshot {
  const content = 'Keep promotional posts in the promotion channel.';
  return { schemaVersion: 1, guildId, observedAt: new Date().toISOString(), coverage: 'complete', sources: [{
    kind: 'message', channelId: '100000000000000002', messageId: '100000000000000003', authorId: '100000000000000004',
    content, contentHash: createHash('sha256').update(content).digest('hex'),
  }] };
}

test('setup enables the built-in preset, captures server guidance and preserves existing budgets and feature choices', async () => {
  const snapshot = guidance();
  const base = validatePolicyConfig(defaultYunaPolicy);
  const result = await prepareServerConfiguration(base, { guildId, autonomous: true, observationModel: 'llm', assessmentModel: 'jev',
    readRules: async () => snapshot });
  assert.equal(result.config.moderation.enabled, true); assert.equal(base.moderation.enabled, false);
  assert.deepEqual(result.config.usage, base.usage);
  assert.equal(result.config.moderation.policy?.evaluationConfiguration.decisionMode, 'autonomous-v1');
  assert.deepEqual(result.config.moderation.policy?.evaluationConfiguration.serverRules, snapshot);
  snapshot.sources[0]!.content = 'later mutation';
  assert.notEqual(result.config.moderation.policy?.evaluationConfiguration.serverRules?.sources[0]?.content, 'later mutation');
  assert.deepEqual(result.rules, { count: 1, coverage: 'complete' });
});

test('a guild without posted rules can use the preset while unavailable, forged or cross-guild rules cannot replace saved guidance', async () => {
  const options = { guildId, autonomous: true, observationModel: 'llm', assessmentModel: 'jev' };
  const empty = { ...guidance(), sources: [] };
  assert.equal((await prepareServerConfiguration(validatePolicyConfig(defaultYunaPolicy), { ...options, readRules: async () => empty })).rules?.count, 0);
  for (const snapshot of [{ ...empty, coverage: 'unavailable' as const }, { ...empty, coverage: 'partial' as const },
    { ...guidance(), guildId: '100000000000000009' }, { ...guidance(), sources: [{ ...guidance().sources[0]!, contentHash: 'forged' }] }]) {
    await assert.rejects(prepareServerConfiguration(validatePolicyConfig(defaultYunaPolicy), { ...options, readRules: async () => snapshot }));
  }
  await assert.rejects(prepareServerConfiguration(validatePolicyConfig(defaultYunaPolicy), { ...options, assessmentModel: undefined,
    readRules: async () => guidance() }));
});

test('disabled moderation skips discovery and normal configure refreshes the selected autonomous policy', async () => {
  let calls = 0;
  const options = { guildId, autonomous: false, observationModel: 'llm', assessmentModel: 'jev',
    readRules: async () => { calls++; return guidance(); } };
  assert.equal((await prepareServerConfiguration(validatePolicyConfig(defaultYunaPolicy), options)).rules, null);
  assert.equal(calls, 0);
  const config = validatePolicyConfig({ ...defaultYunaPolicy, moderation: { enabled: true, policy: createAutonomousModerationPolicy('llm', 'jev') } });
  assert.equal((await prepareServerConfiguration(config, options)).rules?.count, 1);
  assert.equal(calls, 1);
});

test('automatic presets cannot be weakened through hidden rule/mapping overrides and guidance must remain bounded', () => {
  const raw = { ...defaultYunaPolicy, moderation: { enabled: true, mode: 'autonomous' } };
  const config = validatePolicyConfig(raw);
  assert.equal(config.moderation.policy?.actionMapping[1]?.action, 'ban');
  const changed = structuredClone(config);
  changed.moderation.policy!.actionMapping[1]!.deleteMessageSeconds = 604800;
  assert.throws(() => validatePolicyConfig(changed));
  assert.throws(() => validatePolicyConfig({ ...raw, moderation: { ...raw.moderation, policy: config.moderation.policy } }));
  assert.throws(() => validateServerRules({ ...guidance(), sources: new Array(9).fill(guidance().sources[0]) }));
  assert.throws(() => validateServerRules({ ...guidance(), sources: [guidance().sources[0]!, guidance().sources[0]!] }));
});
