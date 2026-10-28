/** Test moderation authority bindings and conversation/reply entity transitions without external effects. */
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { EvidenceRevision, type EvidenceRevisionInput } from '../../src/contexts/moderation/entities/evidence-revision.entity.js';
import { ModerationFinding } from '../../src/contexts/moderation/entities/moderation-finding.entity.js';
import { ModerationAction, hashModerationOperation, type ModerationActionInput, type ModerationOperation } from '../../src/contexts/moderation/entities/moderation-action.entity.js';
import { ModerationCase } from '../../src/contexts/moderation/entities/moderation-case.entity.js';
import { ConversationRequest } from '../../src/contexts/community/entities/conversation-request.entity.js';
import { ReplyDelivery, type ReplyDeliveryInput } from '../../src/contexts/community/entities/reply-delivery.entity.js';
import type { AudienceBinding, InteractionContinuation } from '../../src/contexts/community/entities/community-values.js';

let metadataOrm: MikroORM;
beforeAll(() => {
  metadataOrm = new MikroORM({ entities: [ModerationAction, ModerationFinding], dbName: 'entity_metadata_only' });
});
afterAll(async () => { await metadataOrm?.close(); });

const createdAt = new Date('2026-10-15T00:00:00Z');
/** Convert relative fixture seconds to a deterministic timestamp. */
const at = (seconds: number): Date => new Date(createdAt.getTime() + seconds * 1000);
const guildId = '100000000000000001';
const channelId = '100000000000000002';
const userId = '100000000000000003';
const messageId = '100000000000000004';
/** Build the scoped installation identity used by this fixture. */
const scope = () => ({ installationId: randomUUID(), guildId, createdAt });
/** Build an explicit channel audience for this fixture. */
const audience = (): AudienceBinding => ({ schemaVersion: 1, visibility: 'channel', channelId, requesterUserId: null, revision: 1 });

test('operation identity survives JSONB field reordering while binding exact history and warning destination', () => {
  const ban = { schemaVersion: 1, kind: 'ban', reason: 'Reason', deleteMessageSeconds: 0 } as const;
  assert.equal(hashModerationOperation(userId, ban), hashModerationOperation(userId,
    { reason: 'Reason', deleteMessageSeconds: 0, kind: 'ban', schemaVersion: 1 }));
  assert.notEqual(hashModerationOperation(userId, ban), hashModerationOperation(userId, { ...ban, deleteMessageSeconds: 1 }));
  const warning: ModerationOperation = { schemaVersion: 1, kind: 'warning', text: 'Warning', destination: { kind: 'channel', channelId },
    allowedMentions: { users: [], roles: [], everyone: false } };
  assert.equal(hashModerationOperation(userId, warning), hashModerationOperation(userId,
    { allowedMentions: { everyone: false, roles: [], users: [] }, destination: { channelId, kind: 'channel' }, text: 'Warning', kind: 'warning', schemaVersion: 1 }));
  assert.notEqual(hashModerationOperation(userId, warning), hashModerationOperation(userId, { ...warning, destination: { kind: 'direct_message' } }));
});

/** Build original-evidence input with a fixed author and capture identity. */
function evidenceInput(overrides: Partial<EvidenceRevisionInput> = {}): EvidenceRevisionInput {
  return {
    ...scope(), caseId: randomUUID(), captureRevision: 1, originalEventId: randomUUID(), sourceChannelId: channelId,
    sourceMessageId: messageId, originalAuthorUserId: userId, authorKind: 'user', messageType: 0,
    originalCreatedAt: at(-1), capturedAt: createdAt, originalContent: 'Original rule-breaking content',
    originalAttachmentDescriptors: [], artifactReferences: [], captureCoverage: { schemaVersion: 1, contentAccess: 'available', body: 'captured', attachments: 'none' },
    missingReasons: [], purgeAfter: at(86400), ...overrides,
  };
}
/** Build a policy-authorized action fixture with exact evidence and policy references. */
function policyAction() {
  const evidence = new EvidenceRevision(evidenceInput());
  const policyRevisionId = randomUUID();
  const finding = new ModerationFinding({
    id: randomUUID(), installationId: evidence.installationId, guildId, createdAt,
    caseId: evidence.caseId, evidenceRevisionId: evidence.id, policyRevisionId, ruleId: 'no-abuse', ruleVersion: '1',
    assessmentTaskResultId: randomUUID(), supportedFacts: ['An explicit abusive statement is present.'],
    evidenceReferences: [{ kind: 'original_body', description: 'Retained original message' }], exclusions: [],
    coverage: { schemaVersion: 1, inspectedBody: true, inspectedAttachmentIds: [], limitations: [] },
    disposition: 'violation', acceptedAt: createdAt, purgeAfter: at(86400),
  });
  const action = new ModerationAction({
    installationId: evidence.installationId, guildId, createdAt, targetUserId: userId,
    authority: { origin: 'policy', caseId: evidence.caseId, evidenceRevisionId: evidence.id, policyRevisionId, findings: [finding] },
    operationPayload: { schemaVersion: 1, kind: 'ban', reason: 'Accepted original-evidence violation', deleteMessageSeconds: 0 },
    deduplicationKey: randomUUID(), auditCorrelation: randomUUID(), safetyRevision: 1, purgeAfter: at(86400),
  });
  return { action, evidence, finding, policyRevisionId };
}
/** Build a reply intent fixture with its destination, source and accepted result bound together. */
function deliveryInput(overrides: Partial<ReplyDeliveryInput> = {}): ReplyDeliveryInput {
  return {
    ...scope(), requestId: randomUUID(), acceptedResultReference: randomUUID(), acceptedContent: 'An accepted reply', supportingReferences: [],
    allowedMentions: { users: [], roles: [], everyone: false, repliedUser: false },
    destination: { transport: 'channel_message', channelId, replyMessageId: messageId, nonce: 'stable-logical-reply', enforceNonce: true },
    sourceVersion: 1, privacyRevision: 1, audienceBinding: audience(), deadline: at(60), purgeAfter: at(3600), maxAttempts: 3, ...overrides,
  };
}
/** Claim the fixture delivery with a known executor and generation for outcome tests. */
function claimDelivery(delivery: ReplyDelivery): number {
  return delivery.claimDispatch({ expectedGeneration: delivery.generation, expectedRowRevision: delivery.rowRevision, sourceVersion: 1, privacyRevision: 1, audienceRevision: 1, executorId: 'worker', requestFingerprint: 'a'.repeat(64), at: at(1) });
}

test('missing original body stays distinct from an actually captured empty body', () => {
  const missing = new EvidenceRevision(evidenceInput({ originalContent: null, captureCoverage: { schemaVersion: 1, body: 'missing', contentAccess: 'restricted', attachments: 'none' }, missingReasons: ['message_content_unavailable'] }));
  const empty = new EvidenceRevision(evidenceInput({ originalContent: '' }));
  assert.equal(missing.originalContent, null);
  assert.equal(missing.originalContentHash, null);
  assert.equal(empty.originalContent, '');
  assert.equal(empty.originalContentHash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.throws(() => new EvidenceRevision(evidenceInput({ originalContent: null })), /coverage/);
});

test('an automatic ban needs original findings and no staff review; later captures cannot retarget it', () => {
  const { action, evidence, policyRevisionId } = policyAction();
  assert.equal(action.state, 'READY');
  assert.equal(action.origin, 'policy');
  assert.equal(action.actorUserId, null);
  assert.equal(action.findings.count(), 1);
  const moderationCase = new ModerationCase({ id: evidence.caseId, installationId: evidence.installationId, guildId, createdAt, sourceChannelId: channelId, sourceMessageId: messageId, policyRevisionId });
  moderationCase.completeOriginalCapture(evidence, moderationCase.rowRevision, at(1));
  const nextInput = evidenceInput({ installationId: evidence.installationId, caseId: evidence.caseId, captureRevision: 2, originalEventId: evidence.originalEventId, capturedAt: at(2), supersedesEvidenceId: evidence.id, previousCapture: evidence });
  assert.throws(() => new EvidenceRevision({ ...nextInput, originalContent: 'A later edited message' }), /original body/);
  const completedCapture = new EvidenceRevision(nextInput);
  moderationCase.completeOriginalCapture(completedCapture, moderationCase.rowRevision, at(3));
  assert.equal(moderationCase.currentEvidenceRevisionId, completedCapture.id);
  assert.equal(action.evidenceRevisionId, evidence.id);
  assert.equal(action.findings.getItems()[0]?.evidenceRevisionId, evidence.id);
});

test('unban is restricted to an explicit exact administrator request through Yuna', () => {
  const operation: ModerationOperation = { schemaVersion: 1, kind: 'unban', reason: 'Administrator requested reversal through Yuna' };
  const requestId = randomUUID();
  const input: ModerationActionInput = {
    ...scope(), targetUserId: userId, operationPayload: operation,
    authority: {
      origin: 'staff', sourceRequestId: requestId, actorUserId: userId,
      grantBinding: { schemaVersion: 1, grantId: randomUUID(), revision: 1, operationHash: hashModerationOperation(userId, operation) },
      adminUnbanRequest: { schemaVersion: 1, source: 'yuna', requestId, actorUserId: userId, targetUserId: userId, authorizationKind: 'discord_administrator', authorizedAt: createdAt.toISOString() },
    }, deduplicationKey: randomUUID(), auditCorrelation: randomUUID(), safetyRevision: 1, purgeAfter: at(3600),
  };
  assert.equal(new ModerationAction(input).kind, 'unban');
  const authority = input.authority;
  const { adminUnbanRequest: ignored, ...withoutProof } = authority;
  assert.throws(() => new ModerationAction({ ...input, authority: withoutProof } as unknown as ModerationActionInput), /administrator request/);
  assert.throws(() => new ModerationAction({ ...input, authority: { ...authority, adminUnbanRequest: { ...authority.adminUnbanRequest, targetUserId: '999' } } } as ModerationActionInput), /exact actor, target and request/);
  const { action, finding } = policyAction();
  assert.throws(() => new ModerationAction({ ...input, authority: { origin: 'policy', caseId: action.caseId, evidenceRevisionId: action.evidenceRevisionId, policyRevisionId: action.policyRevisionId, findings: [finding] } } as unknown as ModerationActionInput), /administrator request/);
});

test('elapsed deadlines do not authorize retry or cancellation of uncertain effects', () => {
  const delivery = new ReplyDelivery(deliveryInput());
  const generation = claimDelivery(delivery);
  delivery.recordOutcome(generation, { classification: 'unknown', code: 'connection_lost' }, delivery.rowRevision, at(2));
  assert.throws(() => delivery.expire(delivery.rowRevision, at(70)), /unknown send remains unknown/);
  assert.throws(() => delivery.scheduleRetry(at(80), delivery.rowRevision, at(70)), /uncertain send/);
  assert.throws(() => delivery.cancelBeforeDispatch('source_deleted', delivery.rowRevision, at(70)), /requires reconciliation/);
  assert.equal(delivery.state, 'UNKNOWN');
  const { action } = policyAction();
  const attemptId = randomUUID();
  const actionGeneration = action.claimDispatch({ attemptId, expectedGeneration: 0, expectedRowRevision: action.rowRevision, safetyRevision: 1, evidenceAvailable: true, at: at(1) });
  action.recordOutcome(attemptId, actionGeneration, { classification: 'unknown', code: 'lost_response' }, action.rowRevision, at(2));
  assert.throws(() => action.scheduleRetry(at(4000), action.rowRevision, at(3000)), /definitive non-effect/);
  assert.throws(() => action.cancelBeforeDispatch('lease_expired', action.rowRevision, at(3000)), /cannot be canceled/);
});

test('request cancellation and a confirmed in-flight reply remain independently true', () => {
  const requestScope = scope();
  const request = new ConversationRequest({ ...requestScope, requestKey: messageId, source: { kind: 'message', channelId, messageId }, sourceVersion: 1, settingsRevision: 1, contextBindings: [], audienceBinding: audience(), deadline: at(60), purgeAfter: at(3600) });
  const taskId = randomUUID();
  const resultId = randomUUID();
  request.expectTask(taskId, 'generating', request.rowRevision, createdAt);
  request.acceptReply({ taskId, resultId, sourceVersion: 1, cancellationGeneration: 0, expectedRowRevision: request.rowRevision, at: createdAt });
  const resultPayload: { text?: string } = { text: 'Durably accepted reply' };
  const delivery = new ReplyDelivery(deliveryInput({ ...requestScope, requestId: request.id, acceptedResultReference: resultId, acceptedContent: resultPayload.text! }));
  delete resultPayload.text;
  assert.equal(delivery.acceptedContent, 'Durably accepted reply');
  const generation = claimDelivery(delivery);
  request.cancel('source_edited', request.rowRevision, at(2));
  delivery.recordOutcome(generation, { classification: 'delivered', messageId: '100000000000000005', httpStatus: 200 }, delivery.rowRevision, at(3));
  assert.equal(request.stage, 'canceled');
  assert.equal(request.acceptedResultReference, resultId);
  assert.equal(delivery.state, 'DELIVERED');
});

test('interaction continuation transfers at acceptance and expires without public fallback', () => {
  const requestScope = scope();
  const continuation: InteractionContinuation = { schemaVersion: 1, applicationId: '100000000000000006', interactionId: '100000000000000007', tokenCiphertext: 'encrypted-not-a-plain-token', tokenKeyId: 'key-v1', tokenExpiresAt: at(900).toISOString(), acknowledgment: 'deferred', acknowledgedAt: createdAt.toISOString(), ephemeral: true };
  const privateAudience: AudienceBinding = { ...audience(), visibility: 'requester', requesterUserId: userId };
  const request = new ConversationRequest({ ...requestScope, requestKey: continuation.interactionId, source: { kind: 'interaction', channelId, continuation }, sourceVersion: 1, settingsRevision: 1, contextBindings: [], audienceBinding: privateAudience, deadline: at(1000), purgeAfter: at(3600) });
  const taskId = randomUUID();
  const resultId = randomUUID();
  request.expectTask(taskId, 'generating', request.rowRevision, createdAt);
  const transferred = request.acceptReply({ taskId, resultId, sourceVersion: 1, cancellationGeneration: 0, expectedRowRevision: request.rowRevision, at: createdAt });
  assert.equal(request.interactionContinuation, null);
  assert.ok(transferred);
  const delivery = new ReplyDelivery(deliveryInput({ ...requestScope, requestId: request.id, acceptedResultReference: resultId, destination: { transport: 'interaction_original', continuation: transferred }, audienceBinding: privateAudience, deadline: at(1000) }));
  assert.equal(delivery.tokenCiphertext, continuation.tokenCiphertext);
  assert.equal(delivery.channelId, null);
  delivery.purgeExpiredToken(delivery.rowRevision, at(901));
  assert.equal(delivery.state, 'EXPIRED');
  assert.equal(delivery.transport, 'interaction_original');
  assert.equal(delivery.tokenCiphertext, null);
});
