/** Provider invocations are bounded by persisted worker gates and never repeated after result-write failure. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { ModerationTaskHandlers } from '../../apps/ai-worker/moderation-task.handlers.js';
import { LlmService, LlmError } from '../../src/ai/llm/llm.service.js';
import { JevService } from '../../src/ai/jev/jev.service.js';
import type { ModerationPreparedPayload, ModerationTaskOutcome, ModerationWorkerClaim } from '../../src/platform/jobs/moderation-task.contracts.js';

/** Create a fresh uncanceled signal so one test cannot abort another. */
const signal = () => new AbortController().signal;
/** One real fake capability adapter behind stubbed durable gates; traces make dispatch ordering explicit. */
function fixture(kind: 'moderation.observe' | 'moderation.assess' = 'moderation.observe') {
  const evidenceId = randomUUID(), trace: string[] = [], outcomes: ModerationTaskOutcome[] = [];
  const claim: ModerationWorkerClaim = { taskId: randomUUID(), attemptId: randomUUID(), generation: 1, executorId: 'worker',
    deadline: new Date(Date.now() + 30_000).toISOString(), leaseUntil: new Date(Date.now() + 30_000).toISOString(), kind, schemaVersion: 1, model: 'fake', promptVersion: '1' };
  const llm = new LlmService({ mode: 'fake' }, 1000), jev = new JevService({ mode: 'fake' }, 1000);
  const input = { schemaVersion: 1 as const, evidenceRevisionId: evidenceId, content: 'Original evidence', sourceReferences: [`evidence:${evidenceId}`], maxOutputTokens: 1024 };
  const prepared: ModerationPreparedPayload = kind === 'moderation.observe' ? { schemaVersion: 1, kind, input }
    : { schemaVersion: 1, kind, input: { schemaVersion: 1, configurationVersion: randomUUID(), state: { text: 'Original evidence' }, sourceReferences: [`evidence:${evidenceId}`],
      questions: { relevant: { type: 'noul', instructions: 'Evaluate the supplied statement.' } } },
      observation: { schemaVersion: 1, evidenceRevisionId: evidenceId, sourceReferences: input.sourceReferences, outcome: 'uncertain', uncertaintyReason: 'fake_provider',
        inspectedBody: false, facts: [], limitations: ['fake_provider'], providerRequestId: null, requestedModel: 'fake', model: 'fake', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      observationResultId: randomUUID() };
  const store = { /** Return the fixture claim and record that the worker attempted to acquire work. */ async claimNext() { trace.push('claim'); return claim as ModerationWorkerClaim | null; },
    /** Simulate the input-disclosure gate and return only this test's prepared input. */
    async releasePreparedInput() { trace.push('release'); return prepared as ModerationPreparedPayload | null; },
    /** Record the simulated durable start checkpoint before provider I/O. */
    async recordProviderStart() { trace.push('start'); return true; },
    /** Capture the worker outcome or inject this scenario's storage failure. */
    async recordResult(_claim: ModerationWorkerClaim, outcome: ModerationTaskOutcome) { trace.push('finish'); outcomes.push(outcome); return 'stored' as const; } };
  const providers = {
    llm: { /** Return the test observation without making a provider request. */ async observeContent(...args: Parameters<LlmService['observeContent']>) { trace.push('observe'); return llm.observeContent(...args); } },
    jev: { /** Return the test assessment without making a provider request. */ async assessQuestions(...args: Parameters<JevService['assessQuestions']>) { trace.push('assess'); return jev.assessQuestions(...args); } },
  };
  return { trace, outcomes, claim, store, providers, handler: () => new ModerationTaskHandlers(store, providers.llm, providers.jev, 'worker', 'fake', 'fake', 1000) };
}

test('fixed capability routes call only their provider after claim, release and start', async () => {
  for (const kind of ['moderation.observe', 'moderation.assess'] as const) {
    const f = fixture(kind); assert.equal(await f.handler().runOne(signal(), kind), true);
    assert.deepEqual(f.trace, ['claim', 'release', 'start', kind === 'moderation.observe' ? 'observe' : 'assess', 'finish']);
    assert.equal(f.outcomes[0]!.outcome, 'success'); assert.equal(f.outcomes[0]!.payload!.outcome, 'uncertain');
  }
});

test('empty queue, preexisting cancellation and expired claims perform no provider I/O', async () => {
  const none = fixture(); none.store.claimNext = async () => null;
  assert.equal(await none.handler().runOne(signal(), 'moderation.observe'), false); assert.equal(none.outcomes.length, 0);
  const aborted = fixture(), controller = new AbortController(); controller.abort();
  assert.equal(await aborted.handler().runOne(controller.signal, 'moderation.observe'), false); assert.deepEqual(aborted.trace, []);
  const expired = fixture(); expired.claim.deadline = new Date(Date.now() - 1000).toISOString();
  assert.equal(await expired.handler().runOne(signal(), 'moderation.observe'), true);
  assert.deepEqual(expired.trace, ['claim', 'finish']); assert.equal(expired.outcomes[0]!.reason, 'cancelled_before_release');
});

test('denied disclosure or repeated start cannot dispatch a provider request', async () => {
  const denied = fixture(); denied.store.releasePreparedInput = async () => null;
  await denied.handler().runOne(signal(), 'moderation.observe'); assert.deepEqual(denied.trace, ['claim', 'finish']);
  const start = fixture(); start.store.recordProviderStart = async () => false;
  await start.handler().runOne(signal(), 'moderation.observe'); assert.deepEqual(start.trace, ['claim', 'release', 'finish']);
});

test('known predispatch failures and unknown provider failures preserve safe accounting uncertainty', async () => {
  const known = fixture(); known.providers.llm.observeContent = async () => { throw new LlmError('invalid_input', false); };
  await known.handler().runOne(signal(), 'moderation.observe'); assert.equal(known.outcomes[0]!.outcome, 'failure');
  const unknown = fixture(); unknown.providers.llm.observeContent = async () => { throw new Error('secret response body'); };
  await unknown.handler().runOne(signal(), 'moderation.observe');
  assert.deepEqual(unknown.outcomes[0], { outcome: 'uncertain', reason: 'provider_failure' });
});

test('failure persisting a successful result never retries the provider', async () => {
  const f = fixture(); f.store.recordResult = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.handler().runOne(signal(), 'moderation.observe'), /storage unavailable/);
  assert.equal(f.trace.filter(item => item === 'observe').length, 1); assert.equal(f.outcomes.length, 0);
});
