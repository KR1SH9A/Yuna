import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { GuildSafetyState } from '../../src/contexts/administration/entities/guild-safety-state.entity.js';
import { ActionPlan, type GovernedOperation } from '../../src/contexts/administration/entities/action-plan.entity.js';
import { MemoryScope } from '../../src/contexts/memory/entities/memory-scope.entity.js';
import { MemoryDeletionRequest } from '../../src/contexts/memory/entities/memory-deletion-request.entity.js';
import { DebateSession } from '../../src/contexts/debates/entities/debate-session.entity.js';
import { DebateEvaluation } from '../../src/contexts/debates/entities/debate-evaluation.entity.js';

const installationId = '10000000-0000-4000-8000-000000000001';
const scopeId = '10000000-0000-4000-8000-000000000002';
const planId = '10000000-0000-4000-8000-000000000003';
const transcriptId = '10000000-0000-4000-8000-000000000004';
const taskId = '10000000-0000-4000-8000-000000000005';
const resultId = '10000000-0000-4000-8000-000000000006';
const rubricId = '10000000-0000-4000-8000-000000000007';
const guildId = '100000000000000001';
const userId = '100000000000000002';
const secondUserId = '100000000000000003';
const channelId = '100000000000000004';
const createdAt = new Date('2026-10-15T10:00:00Z');
const later = new Date('2026-10-15T10:01:00Z');
const deadline = new Date('2026-10-15T11:00:00Z');
const expiry = new Date('2026-10-16T10:00:00Z');
const scoped = { installationId, guildId, createdAt };

test('Discord unavailability does not remove, suspend, or replace an installation', () => {
  const installation = new GuildInstallation({ id: installationId, guildId, generation: 9,
    createdAt, registeredAt: createdAt, featureAdmission: { moderation: 'enabled' } });
  installation.recordAvailability('unavailable', later);
  assert.equal(installation.state, 'active');
  assert.equal(installation.generation, 9);
  assert.equal(installation.id, installationId);
  installation.recordAvailability('available', createdAt);
  assert.equal(installation.discordAvailability, 'unavailable', 'Older observations cannot undo the latest outage');
});

test('removal captures required owners, requires acknowledgment, and cannot resurrect a generation', () => {
  const installation = new GuildInstallation({ guildId, generation: 9, createdAt,
    registeredAt: createdAt, featureAdmission: { moderation: 'enabled' } });
  installation.beginRemoval(['moderation', 'usage'], 'uninstalled', later);
  assert.throws(() => installation.completeRemoval(later), /Every required owner/);
  installation.recordCleanupProgress('moderation', { disposition: 'complete', recordedAt: later.toISOString(),
    nextAttemptAt: null, reasonCode: null }, later);
  assert.throws(() => installation.completeRemoval(later), /Every required owner/);
  installation.recordCleanupProgress('usage', { disposition: 'retained', recordedAt: later.toISOString(),
    nextAttemptAt: null, reasonCode: 'unresolved_provider_liability' }, later);
  installation.completeRemoval(later);
  assert.throws(() => installation.resume(later), /cannot resume/);
  const replacement = new GuildInstallation({ guildId, generation: 10, createdAt: later,
    registeredAt: later, featureAdmission: {} });
  assert.notEqual(replacement.id, installation.id);
  assert.equal(installation.generation, 9);
  assert.equal(installation.state, 'removed');
});

test('safety revision fences stale resume authority', () => {
  const safety = new GuildSafetyState({ ...scoped, changedBy: { kind: 'user', userId }, changedAt: createdAt });
  safety.pause(0, { kind: 'user', userId }, 'incident', later);
  assert.throws(() => safety.resume(0, { kind: 'user', userId }, later), /Stale safety revision/);
  assert.equal(safety.paused, true);
  safety.resume(1, { kind: 'user', userId }, later);
  assert.equal(safety.safetyRevision, 2);
});

function plan(operations: readonly GovernedOperation[]): ActionPlan {
  return new ActionPlan({ ...scoped, operations, planHash: 'exact-plan-hash', requesterId: userId,
    sourceRequestId: 'request-1', sourceOperationKey: 'enroll', authorityBinding: { revision: 1 },
    approvalRequirements: { minimumApprovals: 1, excludeRequester: true, excludedUserIds: [] },
    expiresAt: deadline, purgeAfter: expiry });
}

test('capability governance consumes once and cannot authorize an unban', () => {
  const actionPlan = plan([{ kind: 'grant_capability', granteeUserId: userId, capability: 'configure_knowledge',
    channelIds: [], targetUserIds: [] }]);
  assert.throws(() => actionPlan.consume({ planHash: 'exact-plan-hash', eligibleApproverIds: [userId],
    consumptionReference: planId, at: later }), /Requester approval is excluded/);
  actionPlan.consume({ planHash: 'exact-plan-hash', eligibleApproverIds: [secondUserId],
    consumptionReference: planId, at: later });
  assert.throws(() => actionPlan.consume({ planHash: 'exact-plan-hash', eligibleApproverIds: [secondUserId],
    consumptionReference: planId, at: later }), /not consumable/);
  // Runtime validation also rejects an untyped caller bypassing the compile-time union.
  assert.throws(() => plan([{ kind: 'unban', targetUserId: userId } as unknown as GovernedOperation]), /cannot authorize moderation/);
});

test('memory deletion advances a consent fence and waits for each captured owner disposition', () => {
  const scope = new MemoryScope({ ...scoped, id: scopeId, userId,
    privacy: { purposeConsents: { reply_context: { granted: true, changedAt: createdAt.toISOString(), sourceRequestId: 'consent-1' } },
      allowedAudiences: [{ kind: 'subject' }], retentionConfiguration: { maxAgeSeconds: 86400 } } });
  const generation = scope.advanceDeletionFence(0, later);
  assert.throws(() => scope.advanceDeletionFence(0, later), /Stale deletion fence/);
  const deletion = new MemoryDeletionRequest({ ...scoped, scopeId, deletionGeneration: generation,
    selection: { kind: 'scope_cutoff', acceptedBefore: later.toISOString() },
    requiredOwners: ['memory', 'community'], requestedAt: later, purgeAfter: expiry });
  deletion.recordOwnerProgress('memory', generation, { disposition: 'deleted', outstandingReferences: [],
    reasonCode: null, recordedAt: later.toISOString() }, later);
  assert.throws(() => deletion.markCompleted(later), /not all acknowledged/);
  assert.throws(() => deletion.recordOwnerProgress('community', generation, { disposition: 'deleted',
    outstandingReferences: [taskId], reasonCode: null, recordedAt: later.toISOString() }, later), /outstanding copies/);
  deletion.recordOwnerProgress('community', generation, { disposition: 'deleted', outstandingReferences: [],
    reasonCode: null, recordedAt: later.toISOString() }, later);
  deletion.markCompleted(later);
  assert.throws(() => deletion.scheduleRetry(deadline, 'retry', later), /cannot retry/);
});

test('debate evaluation requires current consent and the exact frozen transcript', () => {
  const session = new DebateSession({ ...scoped, sourceRequestId: 'debate-1', sourceOperationKey: 'propose',
    channelId, topic: 'Example topic', invitedUserIds: [userId, secondUserId], scopeRevision: 0,
    consentScope: { schemaVersion: 1, purpose: 'debate_evaluation', audienceChannelId: channelId,
      retentionSeconds: 86400, includeEdits: true, includeDeletedContent: false }, rubricRevisionId: rubricId, purgeAfter: expiry });
  assert.throws(() => session.start([userId], 0, later), /Every invited participant/);
  session.start([userId, secondUserId], 0, later);
  session.freeze(transcriptId, later);
  session.expectEvaluationTasks({ original: taskId }, later);
  assert.throws(() => session.acceptEvaluation({ evaluationId: resultId, transcriptId: scopeId,
    rubricRevisionId: rubricId, completedTaskIds: [taskId], at: later }), /bindings changed/);
  assert.equal(session.state, 'evaluating');
});

test('unknown debate publication cannot resend and remains reconcilable after content purge', () => {
  const evaluation = new DebateEvaluation({ ...scoped, acceptanceOperationKey: 'evaluation-1', sessionId: scopeId,
    transcriptSnapshotId: transcriptId, rubricRevisionId: rubricId, acceptedResults: { original: resultId },
    criterionScores: [{ criterionId: 'clarity', participantId: userId, score: '2.5', explanation: 'Clear reasoning' }],
    evidenceReferences: [], totals: { [userId]: '2.5' }, outcome: { kind: 'uncertain' }, limitations: ['Incomplete evidence'],
    acceptedAt: later, publicationDestination: { channelId, allowedMentionUserIds: [] }, purgeAfter: expiry });
  const claim = { expectedGeneration: 0, executorId: 'bot-1', nonce: 'evaluation-1', requestFingerprint: 'approved-render-hash',
    leaseUntil: deadline, at: later };
  const generation = evaluation.claimPublication(claim);
  evaluation.recordPublicationUncertainty(generation, 'connection_lost', later);
  assert.throws(() => evaluation.claimPublication({ ...claim, expectedGeneration: generation }), /not claimable/);
  evaluation.purgePayload('retention', expiry);
  assert.equal(evaluation.publicationState, 'unknown');
  assert.equal(evaluation.criterionScores, null);
  evaluation.recordPublication(generation, '100000000000000009', expiry);
  assert.equal(evaluation.publicationState, 'published');
});
