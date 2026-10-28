/** Verify exact transcript bindings, rubric arithmetic and conservative typed-score interpretation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from '@jest/globals';
import { DebateScoringPolicy, transcriptHash, type FrozenDebateInput } from '../../src/contexts/debates/debate-scoring.policy.js';
import { parseDebateProposal } from '../../src/contexts/debates/dto/debate-session.dto.js';
import type { AssessmentInput, AssessmentResult } from '../../src/ai/contracts/assessment.contracts.js';
const policy = new DebateScoringPolicy();
/** Supply two attributable, ordered submissions and explicit rubric scoring semantics. */
function fixture(paired = false): FrozenDebateInput {
  const entries = [{ id: randomUUID(), authorId: '1001', sequence: 1, text: 'Evidence for the first argument.' },
    { id: randomUUID(), authorId: '1002', sequence: 2, text: 'Evidence for the second argument.' }];
  return { sessionId: randomUUID(), snapshotId: randomUUID(), contentHash: transcriptHash(entries), rubricId: randomUUID(), participantIds: ['1001', '1002'],
    topic: 'A consented question', entries, model: 'jev-test', rubric: { criteria: [{ id: 'evidence', description: 'Evidence quality', levels: ['Absent', 'Partial', 'Supported'], weight: '0.1' }],
      minimumWinningMargin: '0.05', minimumConfidence: 0.9, paired, maximumPairDifference: 0 } };
}
/** Match the provider's complete typed probability and score legend contract. */
function result(input: AssessmentInput, values = [2, 1]): AssessmentResult {
  const answers: Record<string, AssessmentResult['answers'][string]> = { sufficient: { type: 'noul', noul: 1 } };
  for (const [key, question] of Object.entries(input.questions)) if (question.type === 'score') {
    const score = values[key.endsWith('s0') ? 0 : 1]!;
    answers[key] = { type: 'score', score, confidence: 1, legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])),
      probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === score ? 1 : 0])) };
  }
  return { schemaVersion: 1, configurationVersion: input.configurationVersion, sourceReferences: input.sourceReferences, outcome: 'assessed', uncertaintyReason: null,
    answers, requestedModel: 'jev-test', model: 'jev-test', providerRequestId: 'request', provider: 'test', inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: '0' };
}

test('prepared questions preserve exact declared text and reverse aliases without reordering chronology', () => {
  const input = fixture(), original = policy.prepare(input, 'original'), reversed = policy.prepare(input, 'reversed');
  assert.equal((original.state.transcript as { speaker: string }[])[0]!.speaker, 'speaker_1');
  assert.equal((reversed.state.transcript as { speaker: string }[])[0]!.speaker, 'speaker_2');
  assert.deepEqual(original.sourceReferences, reversed.sourceReferences); assert.equal(Object.keys(original.questions).length, 3);
});
test('weighted totals and winning margin use exact decimal arithmetic', () => {
  const input = fixture(), scores = policy.evaluate(input, { original: result(policy.prepare(input, 'original')) });
  assert.deepEqual(scores.totals, { '1001': '0.2', '1002': '0.1' }); assert.deepEqual(scores.outcome, { kind: 'winner', userId: '1001' });
  assert.equal(scores.evidenceReferences[0]!.quotation, input.entries[0]!.text); assert.match(scores.criterionScores[0]!.explanation, /No provider explanation/);
  const tied = { ...input, rubric: { ...input.rubric, minimumWinningMargin: '0.2' } };
  assert.deepEqual(policy.evaluate(tied, { original: result(policy.prepare(tied, 'original')) }).outcome, { kind: 'tie' });
});
test('paired results map back to the same participants and require both variants', () => {
  const input = fixture(true), original = result(policy.prepare(input, 'original')), reversed = result(policy.prepare(input, 'reversed'), [1, 2]);
  assert.equal(policy.evaluate(input, { original }).outcome.kind, 'uncertain');
  assert.deepEqual(policy.evaluate(input, { original, reversed }).totals, { '1001': '0.2', '1002': '0.1' });
  assert.equal(policy.evaluate(input, { original, reversed: result(policy.prepare(input, 'reversed')) }).outcome.kind, 'uncertain');
});
test('fake, malformed, stale, insufficient and low-confidence results never invent numeric scores', () => {
  const input = fixture(), good = result(policy.prepare(input, 'original'));
  const variants: AssessmentResult[] = [
    { ...good, outcome: 'uncertain', uncertaintyReason: 'fake_provider' }, { ...good, configurationVersion: randomUUID() },
    { ...good, sourceReferences: ['unrelated'] }, { ...good, requestedModel: 'other' }, { ...good, answers: {} },
    { ...good, answers: { ...good.answers, sufficient: { type: 'noul', noul: 0.5 } } },
    { ...good, answers: { ...good.answers, c0_s0: { ...good.answers.c0_s0!, type: 'score', score: 2, confidence: 0.1, probabilities: { '0': 0, '1': 0, '2': 1 }, legend: { '0': 'Absent', '1': 'Partial', '2': 'Supported' } } } },
  ];
  for (const original of variants) { const scores = policy.evaluate(input, { original }); assert.equal(scores.outcome.kind, 'uncertain'); assert.deepEqual(scores.totals, {}); assert.deepEqual(scores.criterionScores, []); }
});
test('forged probability labels or semantic score legends cannot support a winner', () => {
  const input = fixture(), good = result(policy.prepare(input, 'original'));
  for (const answer of [{ ...good.answers.c0_s0!, probabilities: { '0': 0.5, '1': 0.5, '2': 0.5 } },
    { ...good.answers.c0_s0!, legend: { '0': 'Supported', '1': 'Partial', '2': 'Absent' } }]) {
    assert.equal(policy.evaluate(input, { original: { ...good, answers: { ...good.answers, c0_s0: answer } } }).outcome.kind, 'uncertain');
  }
});
test('changed, missing, out-of-scope or excessive transcripts fail before provider preparation', () => {
  const input = fixture();
  for (const changed of [{ ...input, contentHash: 'wrong' }, { ...input, entries: input.entries.slice(0, 1) },
    { ...input, entries: [{ ...input.entries[0]!, authorId: '1003' }, input.entries[1]!] }]) assert.throws(() => policy.prepare(changed, 'original'));
});
test('proposal validation rejects hidden identity fields, implicit thresholds and unbounded rules', () => {
  const input = fixture(), proposal = { channelId: '1003', opponentUserId: '1002', topic: input.topic, retentionSeconds: 3600, rubric: input.rubric };
  assert.deepEqual(parseDebateProposal(proposal), proposal);
  assert.throws(() => parseDebateProposal({ ...proposal, actorId: '1001' }), /Unknown/);
  assert.throws(() => parseDebateProposal({ ...proposal, rubric: { ...input.rubric, minimumConfidence: 0.5 } }), /confidence/);
  assert.throws(() => parseDebateProposal({ ...proposal, rubric: { ...input.rubric, criteria: Array(6).fill(input.rubric.criteria[0]) } }), /five/);
});

test('fractional typed scores preserve their supplied meaning in paired weighted totals', () => {
  const input = fixture(), original = result(policy.prepare(input, 'original'));
  const scored: AssessmentResult = { ...original, answers: { ...original.answers, c0_s0: { type: 'score', score: 1.25, confidence: 1,
    probabilities: { '0': 0, '1': 0.75, '2': 0.25 }, legend: { '0': 'Absent', '1': 'Partial', '2': 'Supported' } } } };
  const value = policy.evaluate(input, { original: scored });
  assert.equal(value.criterionScores[0]!.score, '1.25'); assert.equal(value.totals['1001'], '0.125');
});
