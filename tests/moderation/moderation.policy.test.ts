/** Pure decision boundary tests ensure uncertainty and unsupported model statements never become sanctions. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { ModerationPolicy } from '../../src/contexts/moderation/moderation.policy.js';
import type { RuleDecisionInput } from '../../src/contexts/moderation/contracts.js';
import type { AssessmentResult } from '../../src/ai/contracts/assessment.contracts.js';
import { ModerationPolicyRevision } from '../../src/contexts/moderation/entities/moderation-policy-revision.entity.js';
import { validateOriginalCapture, type OriginalMessageCapture, type OriginalMessageProvenance } from '../../src/platform/intake/intake.service.js';

const policy = new ModerationPolicy();
/** One configured body rule, exact quoted fact and fully bound successful advisory assessment. */
function fixture(): RuleDecisionInput {
  const policyId = randomUUID(), evidenceId = randomUUID();
  return {
    enabled: true, ruleId: 'abuse', policy: { id: policyId, rules: [{ id: 'abuse', version: '1', description: 'Fixture original-author conduct rule', enabled: true }],
      requiredEvidence: [{ ruleId: 'abuse', originalBody: true, originalMedia: false, establishedAuthor: true }], exclusions: [],
      evaluationConfiguration: { schemaVersion: 1, observationModel: 'observe', assessmentModel: 'assess', promptVersion: '1',
        decisionThresholds: { minimumConfidence: 0.9, yesThreshold: 0.95, noThreshold: 0.05 } },
      actionMapping: [{ ruleId: 'abuse', supportedDisposition: 'violation', action: 'ban', deleteMessageSeconds: 0 },
        { ruleId: 'abuse', supportedDisposition: 'suspicion', action: 'warning', deleteMessageSeconds: 0 }] },
    evidence: { guildId: '900000000000000001', installationId: randomUUID(), caseId: randomUUID(), evidenceRevisionId: evidenceId,
      originalEventId: randomUUID(), contentHash: 'hash', sourceUse: 'original_evidence', originalContent: 'Original conduct', authorKind: 'user',
      originalAuthorUserId: '900000000000000002', attachments: [], captureCoverage: { schemaVersion: 1, contentAccess: 'available', body: 'captured', attachments: 'none' },
      missingReasons: [], available: true },
    observation: { evidenceRevisionId: evidenceId, inspectedBody: true, facts: [{ statement: 'Original conduct', quote: 'Original conduct', start: 0, end: 16 }], limitations: [] },
    assessment: { schemaVersion: 1, configurationVersion: policyId, sourceReferences: [`evidence:${evidenceId}`], outcome: 'assessed', uncertaintyReason: null,
      answers: { disposition: { type: 'choice', choice: 'violation', confidence: 0.99, probabilities: { violation: 0.97, suspicion: 0.01, clear: 0.01, incomplete: 0.01 } },
        attributable: { type: 'noul', noul: 0.99 }, excluded: { type: 'noul', noul: 0.01 } },
      requestedModel: 'assess', model: 'assess', providerRequestId: null, provider: null, inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: '0.0001' },
  };
}
/** Change only provider answer data while retaining immutable binding metadata. */
function assessment(input: RuleDecisionInput, changes: Partial<AssessmentResult>): RuleDecisionInput {
  return { ...input, assessment: { ...input.assessment!, ...changes } };
}

test('explicit enabled policy proposes the mapped action using copied exact original quotes', () => {
  const input = fixture(), decision = policy.evaluateRule(input);
  assert.equal(decision.disposition, 'violation'); assert.equal(decision.proposedAction, 'ban');
  assert.notEqual(decision.supportedFacts, input.observation.facts);
  const prepared = policy.prepareRuleAssessment(input.policy, input.ruleId, input.evidence, input.observation);
  assert.equal(prepared.configurationVersion, input.policy.id);
  assert.deepEqual(Object.keys(prepared.questions), ['disposition', 'attributable', 'excluded']);
  assert.equal(prepared.state.originalBody, 'Original conduct');
});

test('supported suspicion can propose a configured warning and never a ban', () => {
  const base = fixture();
  const input = assessment(base, { answers: { ...base.assessment!.answers, disposition: { type: 'choice', choice: 'suspicion', confidence: 0.99,
    probabilities: { violation: 0.01, suspicion: 0.97, clear: 0.01, incomplete: 0.01 } } } });
  assert.equal(policy.evaluateRule(input).proposedAction, 'warning');
  input.policy.actionMapping[1]!.action = 'ban';
  assert.equal(policy.evaluateRule(input).proposedAction, 'none');
});

test('disabled policy/rule and absent explicit thresholds cannot propose an action', () => {
  const input = fixture();
  assert.equal(policy.evaluateRule({ ...input, enabled: false }).proposedAction, 'none');
  input.policy.rules[0]!.enabled = false;
  assert.equal(policy.evaluateRule(input).disposition, 'incomplete');
  input.policy.rules[0]!.enabled = true; delete input.policy.evaluationConfiguration.decisionThresholds;
  assert.equal(policy.evaluateRule(input).reasonCode, 'decision_thresholds_missing');
});

test('fake, missing and stale assessment bindings remain incomplete', () => {
  const input = fixture();
  for (const changed of [null, { ...input.assessment!, outcome: 'uncertain' as const, uncertaintyReason: 'fake_provider' as const },
    { ...input.assessment!, configurationVersion: randomUUID() }, { ...input.assessment!, sourceReferences: [`evidence:${randomUUID()}`] },
    { ...input.assessment!, requestedModel: 'other' }]) {
    const actual = policy.evaluateRule({ ...input, assessment: changed });
    assert.equal(actual.disposition, 'incomplete'); assert.equal(actual.proposedAction, 'none');
  }
});

test('technical uncertainty, middle noul answers and malformed distributions never become suspicion', () => {
  const input = fixture();
  for (const answers of [
    { ...input.assessment!.answers, attributable: { type: 'noul' as const, noul: 0.5 } },
    { ...input.assessment!.answers, excluded: { type: 'noul' as const, noul: 0.5 } },
    { ...input.assessment!.answers, disposition: { type: 'choice' as const, choice: 'suspicion', confidence: 0.5, probabilities: { violation: 0, suspicion: 1, clear: 0, incomplete: 0 } } },
    { ...input.assessment!.answers, disposition: { type: 'choice' as const, choice: 'violation', confidence: 1, probabilities: { violation: 1, suspicion: 1, clear: 0, incomplete: 0 } } },
  ]) {
    const actual = policy.evaluateRule(assessment(input, { answers }));
    assert.equal(actual.disposition, 'incomplete'); assert.equal(actual.proposedAction, 'none');
  }
});

test('a supported exclusion produces clear without an action', () => {
  const input = fixture();
  input.policy.exclusions.push({ id: 'quotation', description: 'Quoted reported conduct is excluded', ruleIds: ['abuse'] });
  const result = policy.evaluateRule(assessment(input, { answers: { ...input.assessment!.answers, excluded: { type: 'noul', noul: 0.99 } } }));
  assert.equal(result.disposition, 'clear'); assert.equal(result.proposedAction, 'none');
});

test('invented facts, wrong spans, wrong revisions and no inspected body are incomplete', () => {
  const input = fixture();
  for (const observation of [
    { ...input.observation, evidenceRevisionId: randomUUID() }, { ...input.observation, inspectedBody: false },
    { ...input.observation, facts: [] }, { ...input.observation, limitations: ['uninspected_context'] },
    { ...input.observation, facts: [{ statement: 'invented allegation', quote: 'Original conduct', start: 0, end: 16 }] },
    { ...input.observation, facts: [{ statement: 'Original conduct', quote: 'Original conduct', start: 1, end: 17 }] },
  ]) assert.equal(policy.evaluateRule({ ...input, observation }).disposition, 'incomplete');
});

test('missing/restricted/purged bodies, nonhuman attribution and required media stay incomplete', () => {
  const input = fixture();
  for (const evidence of [{ ...input.evidence, available: false }, { ...input.evidence, originalContent: null },
    { ...input.evidence, authorKind: 'webhook' as const, originalAuthorUserId: null }, { ...input.evidence, authorKind: 'bot' as const },
    { ...input.evidence, captureCoverage: { ...input.evidence.captureCoverage, contentAccess: 'restricted' as const } }]) {
    assert.equal(policy.evaluateRule({ ...input, evidence }).disposition, 'incomplete');
  }
  input.policy.requiredEvidence[0]!.originalMedia = true;
  assert.equal(policy.evaluateRule(input).reasonCode, 'original_media_uninspected');
});

test('empty/technical findings do not escalate severity and clear does not hide missing work', () => {
  const decision = policy.evaluateRule(fixture());
  assert.equal(policy.selectDisposition([]), 'incomplete');
  assert.equal(policy.selectDisposition([{ ...decision, disposition: 'clear' }, { ...decision, disposition: 'incomplete' }]), 'incomplete');
  assert.equal(policy.selectDisposition([{ ...decision, disposition: 'suspicion' }, { ...decision, disposition: 'incomplete' }]), 'suspicion');
});

test('prepared assessment body is bounded and unsupported observations cannot enter it', () => {
  const input = fixture();
  assert.throws(() => policy.prepareRuleAssessment(input.policy, input.ruleId, input.evidence, { ...input.observation, evidenceRevisionId: randomUUID() }));
  assert.throws(() => policy.prepareRuleAssessment(input.policy, input.ruleId, { ...input.evidence, originalContent: 'x'.repeat(40_000) }, { ...input.observation, facts: [] }), /bounded/);
});

test('entity rejects invalid explicit threshold boundaries and accepts disabled drafts without thresholds', () => {
  const input = fixture();
  /** Construct a policy revision with the supplied threshold boundary under test. */
  const create = (thresholds: { minimumConfidence: number; yesThreshold: number; noThreshold: number } | undefined) => new ModerationPolicyRevision({
    ...input.policy, installationId: input.evidence.installationId, guildId: input.evidence.guildId, revisionNumber: 1,
    evaluationConfiguration: { schemaVersion: 1, observationModel: 'observe', assessmentModel: 'assess', promptVersion: '1', ...(thresholds ? { decisionThresholds: thresholds } : {}) },
    publisherUserId: '900000000000000002', publisherRequestId: 'request', publishedAt: new Date(),
  });
  assert.doesNotThrow(() => create(undefined));
  for (const thresholds of [{ minimumConfidence: 0.5, yesThreshold: 0.9, noThreshold: 0.1 },
    { minimumConfidence: 0.9, yesThreshold: 0.5, noThreshold: 0.1 }, { minimumConfidence: 0.9, yesThreshold: 0.9, noThreshold: 0.5 },
    { minimumConfidence: NaN, yesThreshold: 0.9, noThreshold: 0.1 }]) assert.throws(() => create(thresholds));
});

test('original boundary preserves accessible empty content and rejects edits, invented authors and excessive data', () => {
  const provenance: OriginalMessageProvenance = { guildId: '900000000000000001', channelId: '900000000000000003', messageId: '900000000000000004',
    eventKind: 'message_create', authorKind: 'user', authorUserId: '900000000000000002', webhookId: null, messageType: 0, createdAt: new Date(), observedAt: new Date() };
  const capture: OriginalMessageCapture = { originalContent: '', attachments: [], contentAccess: 'available', attachmentsComplete: true, missingReasons: [] };
  assert.doesNotThrow(() => validateOriginalCapture(provenance, capture));
  assert.throws(() => validateOriginalCapture({ ...provenance, eventKind: 'message_update' as 'message_create' }, capture));
  assert.throws(() => validateOriginalCapture({ ...provenance, authorKind: 'webhook' }, capture));
  assert.throws(() => validateOriginalCapture(provenance, { ...capture, contentAccess: 'restricted' }));
  assert.throws(() => validateOriginalCapture(provenance, { ...capture, originalContent: 'x'.repeat(100_001) }));
  assert.throws(() => validateOriginalCapture(provenance, { ...capture, missingReasons: ['unbounded reason text'] }));
});
