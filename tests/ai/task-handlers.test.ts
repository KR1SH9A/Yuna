import assert from 'node:assert/strict';
import { jest, test } from '@jest/globals';
import { AiTaskHandlers } from '../../apps/ai-worker/task.handlers.js';
import { LlmError, type LlmService } from '../../src/ai/llm/llm.service.js';
import type { ReplyGenerationResult } from '../../src/ai/contracts/generation.contracts.js';
import type { WorkerTaskStore, WorkerClaim, ConversationTaskOutcome } from '../../src/platform/jobs/worker-task.store.js';

type Store = Pick<WorkerTaskStore, 'claimNext' | 'releasePreparedInput' | 'recordProviderStart' | 'recordResult'>;
const generated: ReplyGenerationResult = Object.freeze({ text: 'Hello!', providerRequestId: 'fixture-provider-request',
  model: 'fixture-model', inputTokens: 10, outputTokens: 3, totalTokens: 13, truncated: false });

/** Every operation records its order; replacements model races at committed database boundaries. */
function harness() {
  const events: string[] = [];
  const outcomes: ConversationTaskOutcome[] = [];
  const claim: WorkerClaim = { taskId: 'task', attemptId: 'attempt', generation: 1, executorId: 'fixture-executor',
    deadline: new Date(Date.now() + 30_000).toISOString(), leaseUntil: new Date(Date.now() + 20_000).toISOString(),
    kind: 'community.generate', schemaVersion: 1, model: 'fixture-model', promptVersion: 'conversation-v1' };
  const input = { text: 'Hello', previousReply: 'Earlier reply', maxOutputTokens: 512 };
  const store: Store = {
    async claimNext(executorId, model) {
      events.push('claim');
      assert.equal(executorId, claim.executorId);
      assert.equal(model, claim.model);
      return claim;
    },
    async releasePreparedInput(actual) { events.push('release'); assert.equal(actual, claim); return input; },
    async recordProviderStart(actual) { events.push('start'); assert.equal(actual, claim); return true; },
    async recordResult(actual, outcome) {
      events.push('result');
      assert.equal(actual, claim);
      outcomes.push(outcome);
      return 'stored';
    },
  };
  const llm: Pick<LlmService, 'generateReply'> = {
    async generateReply(actual, signal) {
      events.push('provider');
      assert.equal(actual, input);
      assert.equal(signal?.aborted, false);
      return generated;
    },
  };
  const handler = new AiTaskHandlers(store, llm, claim.executorId, claim.model, 1_000);
  return { handler, store, llm, claim, input, events, outcomes };
}

test('an already canceled worker never claims or discloses a task', async () => {
  const fixture = harness();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await fixture.handler.runOne(controller.signal), false);
  assert.deepEqual(fixture.events, []);
});

test('an empty claim ends the iteration without touching inputs or providers', async () => {
  const fixture = harness();
  fixture.store.claimNext = async () => { fixture.events.push('claim'); return null; };
  assert.equal(await fixture.handler.runOne(new AbortController().signal), false);
  assert.deepEqual(fixture.events, ['claim']);
});

test('claim, disclosure and committed dispatch intent precede one provider call and measured result', async () => {
  const fixture = harness();
  assert.equal(await fixture.handler.runOne(new AbortController().signal), true);
  assert.deepEqual(fixture.events, ['claim', 'release', 'start', 'provider', 'result']);
  assert.deepEqual(fixture.outcomes, [{ outcome: 'success', reason: 'generated', payload: generated,
    providerRequestId: generated.providerRequestId, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }]);
});

test('expired deadlines or leases prevent prepared-input disclosure', async () => {
  for (const field of ['deadline', 'leaseUntil'] as const) {
    const fixture = harness();
    fixture.claim[field] = new Date(Date.now() - 1).toISOString();
    assert.equal(await fixture.handler.runOne(new AbortController().signal), true);
    assert.deepEqual(fixture.events, ['claim', 'result']);
    assert.deepEqual(fixture.outcomes, [{ outcome: 'failure', reason: 'cancelled_before_release' }]);
  }
});

test('cancellation while a claim is committed prevents the subsequent disclosure', async () => {
  const fixture = harness();
  const controller = new AbortController();
  fixture.store.claimNext = async () => { fixture.events.push('claim'); controller.abort(); return fixture.claim; };
  assert.equal(await fixture.handler.runOne(controller.signal), true);
  assert.deepEqual(fixture.events, ['claim', 'result']);
  assert.equal(fixture.outcomes[0]?.reason, 'cancelled_before_release');
});

test('denied disclosure, canceled disclosure and denied dispatch gates never call the provider', async () => {
  for (const mode of ['missing-input', 'cancel-after-release', 'start-denied']) {
    const fixture = harness();
    const controller = new AbortController();
    if (mode !== 'start-denied') fixture.store.releasePreparedInput = async () => {
      fixture.events.push('release');
      if (mode === 'cancel-after-release') controller.abort();
      return mode === 'missing-input' ? null : fixture.input;
    };
    else fixture.store.recordProviderStart = async () => { fixture.events.push('start'); return false; };
    assert.equal(await fixture.handler.runOne(controller.signal), true);
    assert.deepEqual(fixture.events, mode === 'start-denied' ? ['claim', 'release', 'start', 'result'] : ['claim', 'release', 'result']);
    assert.deepEqual(fixture.outcomes, [{ outcome: 'failure', reason: 'disclosure_denied' }]);
  }
});

test('cancellation or an expired lease during dispatch-intent persistence is rechecked before generation', async () => {
  for (const mode of ['cancelled', 'expired']) {
    const fixture = harness();
    const controller = new AbortController();
    fixture.store.recordProviderStart = async () => {
      fixture.events.push('start');
      if (mode === 'cancelled') controller.abort(); else fixture.claim.leaseUntil = new Date(Date.now() - 1).toISOString();
      return true;
    };
    assert.equal(await fixture.handler.runOne(controller.signal), true);
    assert.deepEqual(fixture.events, ['claim', 'release', 'start', 'result']);
    assert.deepEqual(fixture.outcomes, [{ outcome: 'failure', reason: 'cancelled_before_provider' }]);
  }
});

test('provider failures preserve uncertain spend and only log bounded classifications', async () => {
  const warnings: string[] = [];
  const warn = jest.spyOn(console, 'warn').mockImplementation(message => { warnings.push(String(message)); });
  try {
    for (const error of [new LlmError('invalid_input', false), new LlmError('timeout', true),
      new Error('fixture-secret-provider-error', { cause: new Error('fixture-secret-cause') })]) {
      const fixture = harness();
      fixture.llm.generateReply = async () => { fixture.events.push('provider'); throw error; };
      assert.equal(await fixture.handler.runOne(new AbortController().signal), true);
      assert.deepEqual(fixture.events, ['claim', 'release', 'start', 'provider', 'result']);
      assert.deepEqual(fixture.outcomes, [{ outcome: error instanceof LlmError && !error.costMayHaveBeenIncurred ? 'failure' : 'uncertain',
        reason: error instanceof LlmError ? error.code : 'provider_failure' }]);
    }
    assert.equal(warnings.length, 3);
    assert.ok(warnings.every(message => !message.includes('fixture-secret')));
  } finally { warn.mockRestore(); }
});

test('shutdown abort propagates to an active provider call and records an uncertain outcome', async () => {
  const fixture = harness();
  const controller = new AbortController();
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  fixture.llm.generateReply = async (_input, signal) => new Promise((_resolve, reject) => {
    fixture.events.push('provider');
    signal!.addEventListener('abort', () => reject(new LlmError('cancelled', true)), { once: true });
    start();
  });
  try {
    const pending = fixture.handler.runOne(controller.signal);
    await started;
    controller.abort();
    assert.equal(await pending, true);
    assert.deepEqual(fixture.outcomes, [{ outcome: 'uncertain', reason: 'cancelled' }]);
    assert.equal(fixture.events.filter(event => event === 'provider').length, 1);
  } finally { warn.mockRestore(); }
}, 2_000);

test('successful generation followed by result persistence failure never reissues the provider request', async () => {
  const fixture = harness();
  const failure = new Error('fixture-storage-failure');
  fixture.store.recordResult = async () => { fixture.events.push('result'); throw failure; };
  await assert.rejects(fixture.handler.runOne(new AbortController().signal), error => error === failure);
  assert.deepEqual(fixture.events, ['claim', 'release', 'start', 'provider', 'result']);
});

test('a failure to persist uncertain provider outcomes also propagates without a second attempt', async () => {
  const fixture = harness();
  const failure = new Error('fixture-storage-failure');
  fixture.llm.generateReply = async () => { fixture.events.push('provider'); throw new LlmError('network', true); };
  fixture.store.recordResult = async () => { fixture.events.push('result'); throw failure; };
  await assert.rejects(fixture.handler.runOne(new AbortController().signal), error => error === failure);
  assert.deepEqual(fixture.events, ['claim', 'release', 'start', 'provider', 'result']);
});

test('stale result acceptance ends the attempt and does not trigger another generation', async () => {
  const fixture = harness();
  fixture.store.recordResult = async () => { fixture.events.push('result'); return 'stale'; };
  assert.equal(await fixture.handler.runOne(new AbortController().signal), true);
  assert.deepEqual(fixture.events, ['claim', 'release', 'start', 'provider', 'result']);
});

test('database gate failures propagate before any provider call', async () => {
  for (const method of ['claimNext', 'releasePreparedInput', 'recordProviderStart'] as const) {
    const fixture = harness();
    const failure = new Error('fixture-gate-failure');
    fixture.store[method] = async () => { throw failure; };
    await assert.rejects(fixture.handler.runOne(new AbortController().signal), error => error === failure);
    assert.ok(!fixture.events.includes('provider'));
    assert.ok(!fixture.events.includes('result'));
  }
});
