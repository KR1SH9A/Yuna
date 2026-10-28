/** Verify one-shot Jev routing and safe failure recording independently of worker SQL and real providers. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { DebateTaskHandlers } from '../../apps/ai-worker/debate-task.handlers.js';
import { JevError } from '../../src/ai/jev/jev.service.js';
import type { DebateTaskOutcome, DebateWorkerClaim } from '../../src/platform/jobs/debate-task.contracts.js';
import type { AssessmentInput, AssessmentResult } from '../../src/ai/contracts/assessment.contracts.js';

/** Fake only external boundaries; keep ordering and durable result failures observable. */
function fixture(options: { claimed?: boolean; released?: boolean; started?: boolean; expired?: boolean; failure?: Error; writeFailure?: boolean } = {}) {
  const calls: string[] = [], outcomes: DebateTaskOutcome[] = [];
  const input: AssessmentInput = { schemaVersion: 1, configurationVersion: 'rubric', state: {}, questions: { sufficient: { type: 'noul', instructions: 'Enough evidence?' } }, sourceReferences: ['transcript:test'] };
  const claim: DebateWorkerClaim = { taskId: 'task', attemptId: 'attempt', generation: 1, executorId: 'worker', kind: 'debates.assess', schemaVersion: 1,
    model: 'test-model', promptVersion: 'debates-score-v1', deadline: new Date(Date.now() + (options.expired ? -1000 : 60000)).toISOString(), leaseUntil: new Date(Date.now() + 60000).toISOString() };
  const answer: AssessmentResult = { schemaVersion: 1, configurationVersion: 'rubric', sourceReferences: input.sourceReferences, outcome: 'uncertain', uncertaintyReason: 'fake_provider',
    answers: { sufficient: { type: 'noul', noul: 0.5 } }, requestedModel: 'test-model', model: 'test-model', providerRequestId: null, provider: null,
    inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: '0.000000000000000001' };
  const store = {
    /** Claim only the composition-selected model. */
    async claimNext(executor: string, model: string) { calls.push('claim'); assert.equal(executor, 'worker'); assert.equal(model, 'test-model'); return options.claimed === false ? null : claim; },
    /** Simulate one released immutable prepared envelope. */
    async releasePreparedInput() { calls.push('release'); return options.released === false ? null : { schemaVersion: 1 as const, kind: 'debates.assess' as const, input }; },
    /** The dispatch gate remains independent from input release. */
    async recordProviderStart() { calls.push('start'); return options.started !== false; },
    /** A storage failure must escape without restarting the provider. */
    async recordResult(_claim: DebateWorkerClaim, outcome: DebateTaskOutcome) { calls.push('record'); if (options.writeFailure) throw new Error('database unavailable'); outcomes.push(outcome); return 'stored' as const; },
  };
  const jev = { /** Count exactly one explicit capability invocation and preserve supplied provider outcome semantics. */
    async assessQuestions(value: AssessmentInput, signal?: AbortSignal) { calls.push('provider'); assert.equal(value, input); assert(signal); if (options.failure) throw options.failure; return answer; } };
  return { handler: new DebateTaskHandlers(store, jev, 'worker', 'test-model', 1000), calls, outcomes };
}

test('route commits claim, disclosure and dispatch before one Jev call and exact usage write', async () => {
  const f = fixture(); assert.equal(await f.handler.runOne(new AbortController().signal), true);
  assert.deepEqual(f.calls, ['claim', 'release', 'start', 'provider', 'record']); assert.equal(f.outcomes[0]!.usage!.costUsd, '0.000000000000000001');
  assert.equal(f.outcomes[0]!.payload!.outcome, 'uncertain');
});
test('empty, canceled, expired or revoked work cannot call the provider', async () => {
  const canceled = fixture(), controller = new AbortController(); controller.abort(); assert.equal(await canceled.handler.runOne(controller.signal), false); assert.deepEqual(canceled.calls, []);
  for (const options of [{ claimed: false }, { expired: true }, { released: false }, { started: false }]) {
    const f = fixture(options); await f.handler.runOne(new AbortController().signal); assert(!f.calls.includes('provider'));
  }
});
test('safe Jev errors retain spend uncertainty and generic exceptions never leak provider text', async () => {
  for (const failure of [new JevError('timeout', true), new Error('secret provider response')]) {
    const f = fixture({ failure }); await f.handler.runOne(new AbortController().signal);
    assert.equal(f.outcomes[0]!.outcome, 'uncertain'); assert(!JSON.stringify(f.outcomes).includes('secret'));
  }
});
test('failed result persistence escapes after one call without repeating inference', async () => {
  const f = fixture({ writeFailure: true }); await assert.rejects(f.handler.runOne(new AbortController().signal), /database unavailable/);
  assert.equal(f.calls.filter(call => call === 'provider').length, 1);
});
