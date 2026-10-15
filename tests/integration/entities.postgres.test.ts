import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { createEntitySchemaSql } from '../../src/platform/db/schema-constraints.js';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { UsagePolicy } from '../../src/contexts/administration/entities/usage-policy.entity.js';
import { IntakeEvent } from '../../src/platform/intake/entities/intake-event.entity.js';
import { ModerationPolicyRevision } from '../../src/contexts/moderation/entities/moderation-policy-revision.entity.js';
import { ModerationCase } from '../../src/contexts/moderation/entities/moderation-case.entity.js';
import { EvidenceRevision } from '../../src/contexts/moderation/entities/evidence-revision.entity.js';
import { ModerationFinding } from '../../src/contexts/moderation/entities/moderation-finding.entity.js';
import { ModerationAction, hashModerationOperation } from '../../src/contexts/moderation/entities/moderation-action.entity.js';
import { ActionAttempt } from '../../src/contexts/moderation/entities/action-attempt.entity.js';
import { AiTask } from '../../src/platform/jobs/entities/ai-task.entity.js';
import { PreparedInput } from '../../src/platform/jobs/entities/prepared-input.entity.js';
import { TaskAttempt } from '../../src/platform/jobs/entities/task-attempt.entity.js';
import { TaskResult } from '../../src/platform/jobs/entities/task-result.entity.js';
import { UsageReservation } from '../../src/platform/usage/entities/usage-reservation.entity.js';

const at = (seconds: number) => new Date(Date.parse('2026-10-15T10:00:00Z') + seconds * 1000);
let database: ReturnType<typeof temporaryPostgres>;
let orm: MikroORM;

before(async () => {
  database = temporaryPostgres();
  orm = new MikroORM({ ...entityOrmConfig({ includeStaged: true }), ...database.options });
  await orm.connect();
  database.applySchema(await createEntitySchemaSql(orm));
});
after(async () => {
  if (orm) await orm.close(true);
  database?.close();
});

function installation(guildId = '900000000000000001') {
  return new GuildInstallation({ guildId, generation: 1, registeredAt: at(0), createdAt: at(0), featureAdmission: { moderation: 'enabled' } });
}

/** Complete local acceptance graph; no provider, worker or Discord integration is mocked as implemented. */
function moderationGraph(guildId: string) {
  const installed = installation(guildId);
  const scope = { installationId: installed.id, guildId, createdAt: at(0) };
  const event = new IntakeEvent({ ...scope, eventKind: 'message_create', sourceEventKey: `create:${guildId}`, sourceKey: '900000000000000003/900000000000000004',
    ingressSequence: 9_007_199_254_740_993n, observedAt: at(0), authorKind: 'user', authorUserId: '900000000000000002',
    contentAccess: 'available', coverage: [], snapshot: { schemaVersion: 1, fields: { content: 'Original captured text' } }, purgeAfter: at(30), metadataPurgeAfter: at(1000) });
  const policy = new ModerationPolicyRevision({ ...scope, revisionNumber: 1, rules: [{ id: 'r1', version: '1', description: 'Fixture rule', enabled: true }],
    requiredEvidence: [{ ruleId: 'r1', originalBody: true, originalMedia: false, establishedAuthor: true }], exclusions: [],
    evaluationConfiguration: { schemaVersion: 1, observationModel: 'fixture', assessmentModel: 'fixture', promptVersion: '1' },
    actionMapping: [{ ruleId: 'r1', supportedDisposition: 'violation', action: 'ban', deleteMessageSeconds: 0 }], publisherUserId: '900000000000000005', publisherRequestId: 'publish', publishedAt: at(0) });
  const caseRecord = new ModerationCase({ ...scope, sourceChannelId: '900000000000000003', sourceMessageId: '900000000000000004', policyRevisionId: policy.id });
  const evidence = new EvidenceRevision({ ...scope, caseId: caseRecord.id, captureRevision: 1, originalEventId: event.id,
    sourceChannelId: caseRecord.sourceChannelId, sourceMessageId: caseRecord.sourceMessageId, originalAuthorUserId: event.authorUserId, authorKind: 'user', messageType: 0,
    originalCreatedAt: at(0), capturedAt: at(0), originalContent: 'Original captured text', originalAttachmentDescriptors: [], artifactReferences: [],
    captureCoverage: { schemaVersion: 1, contentAccess: 'available', body: 'captured', attachments: 'none' }, missingReasons: [], purgeAfter: at(1000) });
  caseRecord.completeOriginalCapture(evidence, caseRecord.rowRevision, at(1));
  const taskId = randomUUID(), inputId = randomUUID(), attemptId = randomUUID();
  const task = new AiTask({ ...scope, id: taskId, owner: 'moderation', operationKey: caseRecord.id, kind: 'moderation.assess', schemaVersion: 1,
    preparedInputId: inputId, inputHash: 'fixture-hash', sourceUse: 'original_evidence', validityBindings: { evidenceRevisionId: evidence.id },
    providerConfigurationVersion: '1', modelVersion: '1', promptVersion: '1', maxAttempts: 2 });
  const input = new PreparedInput({ ...scope, id: inputId, taskId, schemaVersion: 1, payload: { content: 'Original captured text' }, contentHash: 'fixture-hash',
    artifactHandles: [], provenance: { eventId: event.id }, purpose: 'moderation', audience: { kind: 'internal' }, sourceUse: 'original_evidence',
    validityBindings: { evidenceRevisionId: evidence.id }, purgeAfter: at(30) });
  const usagePolicy = new UsagePolicy({ ...scope, configuration: { schemaVersion: 1, limits: [], windowRules: [], perAttemptBounds: [] }, effectiveAt: at(0), updatedBy: { kind: 'system', operation: 'fixture' } });
  const reservation = new UsageReservation({ ...scope, feature: 'moderation', provider: 'fixture', modelRoute: '1', operationKind: 'task-attempt', operationKey: taskId,
    taskId, attemptNumber: 1, reservedUnits: { tokens: 1 }, reservedCost: { amount: '0.000000000000000001', currency: 'USD' }, usagePolicyId: usagePolicy.id,
    policyRevision: 0, policySnapshot: { schemaVersion: 1 }, pricingVersion: '1', budgetWindows: [{ key: 'fixture', startsAt: at(0).toISOString(), endsAt: at(1000).toISOString() }], reconcileAfter: at(20), purgeAfter: at(1000) });
  const generation = task.claimAttempt(attemptId, at(1));
  const attempt = new TaskAttempt({ ...scope, id: attemptId, taskId, attemptNumber: 1, generation, executorId: 'fixture', reservationId: reservation.id, claimedAt: at(1), leaseUntil: at(10) });
  reservation.bindAttempt(attemptId, at(1));
  attempt.recordInputRelease(generation, at(2));
  attempt.recordProviderStart(generation, at(2));
  attempt.finish(generation, at(3));
  task.finalize(generation, at(3));
  const result = new TaskResult({ ...scope, taskId, attemptId, attemptGeneration: generation, schemaVersion: 1, outcome: 'success', payload: { facts: ['Supported fixture fact'] }, reason: 'completed', completedAt: at(3), purgeAfter: at(30), usageReservationId: reservation.id });
  const finding = new ModerationFinding({ ...scope, caseId: caseRecord.id, evidenceRevisionId: evidence.id, policyRevisionId: policy.id,
    ruleId: 'r1', ruleVersion: '1', assessmentTaskResultId: result.id, supportedFacts: ['Supported fixture fact'],
    evidenceReferences: [{ kind: 'original_body', description: 'Original captured text' }], exclusions: [], coverage: { schemaVersion: 1, inspectedBody: true, inspectedAttachmentIds: [], limitations: [] },
    disposition: 'violation', acceptedAt: at(4), purgeAfter: at(1000) });
  const action = new ModerationAction({ ...scope, createdAt: at(4), targetUserId: '900000000000000002', authority: { origin: 'policy', caseId: caseRecord.id, evidenceRevisionId: evidence.id, policyRevisionId: policy.id, findings: [finding] },
    deduplicationKey: `ban:${caseRecord.id}`, operationPayload: { schemaVersion: 1, kind: 'ban', reason: 'Fixture rule violation', deleteMessageSeconds: 0 }, auditCorrelation: `action:${caseRecord.id}`, safetyRevision: 0, purgeAfter: at(900) });
  return { installed, scope, event, policy, caseRecord, evidence, task, input, usagePolicy, reservation, attempt, result, finding, action,
    records: [installed, event, policy, caseRecord, evidence, task, input, usagePolicy, reservation, attempt, result, finding, action] };
}

test('full schema creates 40 records and the private action/finding relation', async () => {
  const rows = await orm.em.fork().execute<{ count: string }[]>("select count(*)::text as count from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
  assert.equal(rows[0]?.count, '41');
  const fks = await orm.em.fork().execute<{ count: string }[]>("select count(*)::text as count from pg_constraint where contype='f'");
  assert.ok(Number(fks[0]?.count) >= 70, 'Scoped constraints must not disappear during ORM discovery');
});

test('default schema excludes staged features but keeps scoped core constraints', async () => {
  await orm.em.fork().execute('create database yuna_core');
  const core = new MikroORM({ ...entityOrmConfig(), ...database.options, dbName: 'yuna_core' });
  try {
    database.applySchema(await createEntitySchemaSql(core), 'yuna_core');
    const rows = await core.em.fork().execute<{ count: string }[]>("select count(*)::text as count from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
    assert.equal(rows[0]?.count, '28');
    const disabled = await core.em.fork().execute<{ count: string }[]>("select count(*)::text as count from pg_constraint where conname='prepared_input_privacy_scope_id_disabled'");
    assert.equal(disabled[0]?.count, '1');
  } finally { await core.close(true); }
});

test('persisted unban requires an exact explicit administrator request through Yuna', async () => {
  const installed = installation('900000000000000401');
  const targetUserId = '900000000000000402', actorUserId = '900000000000000403';
  const operationPayload = { schemaVersion: 1 as const, kind: 'unban' as const, reason: 'Explicit administrator request' };
  const action = new ModerationAction({ installationId: installed.id, guildId: installed.guildId, createdAt: at(1), targetUserId,
    authority: { origin: 'staff', actorUserId, sourceRequestId: 'yuna-request-1',
      grantBinding: { schemaVersion: 1, grantId: randomUUID(), revision: 1, operationHash: hashModerationOperation(targetUserId, operationPayload) },
      adminUnbanRequest: { schemaVersion: 1, source: 'yuna', requestId: 'yuna-request-1', actorUserId, targetUserId, authorizationKind: 'discord_administrator', authorizedAt: at(0).toISOString() } },
    deduplicationKey: 'explicit-unban-1', operationPayload, auditCorrelation: 'explicit-unban-1', safetyRevision: 0, purgeAfter: at(1000) });
  const em = orm.em.fork(); em.persist([installed, action]); await em.flush(); em.clear();
  const stored = await em.findOneOrFail(ModerationAction, action.id);
  assert.equal(stored.adminUnbanRequest?.requestId, 'yuna-request-1');
  await assert.rejects(orm.em.fork().execute('update moderation_action set admin_unban_request = null where id = ?', [action.id]));
  await assert.rejects(orm.em.fork().execute("update moderation_action set admin_unban_request = '{}'::jsonb where id = ?", [action.id]));
});

test('automatic ban reloads original evidence and accepted reason after intake/job payload cleanup', async () => {
  const graph = moderationGraph('900000000000000101');
  const em = orm.em.fork();
  em.persist(graph.records);
  await em.flush();
  graph.event.purgePayload(at(31), 'retention');
  graph.result.purgePayload({ reason: 'retention', mode: 'retention', ownerAcknowledged: true, now: at(31) });
  graph.input.invalidate('retention', at(31));
  graph.input.purgePayload('retention', at(31));
  await em.flush();
  em.clear();
  const action = await em.findOneOrFail(ModerationAction, graph.action.id, { populate: ['findings'] });
  const original = await em.findOneOrFail(EvidenceRevision, action.evidenceRevisionId!);
  assert.equal(action.origin, 'policy');
  assert.equal(original.originalContent, 'Original captured text');
  assert.deepEqual(action.findings.getItems()[0]?.supportedFacts, ['Supported fixture fact']);
  assert.equal((await em.findOneOrFail(IntakeEvent, graph.event.id)).ingressSequence, 9_007_199_254_740_993n);
  assert.equal((await em.findOneOrFail(UsageReservation, graph.reservation.id)).reservedCost, '0.000000000000000001');
  const effectAttempt = new ActionAttempt({ ...graph.scope, actionId: action.id, attemptNumber: 1, dispatchGeneration: 1, executorId: 'bot', leaseUntil: at(100), claimedAt: at(32), endpoint: 'create_guild_ban', destination: { guildId: graph.scope.guildId, targetUserId: action.targetUserId }, requestFingerprint: 'a'.repeat(64) });
  const generation = action.claimDispatch({ attemptId: effectAttempt.id, expectedGeneration: 0, expectedRowRevision: action.rowRevision, safetyRevision: 0, evidenceAvailable: true, at: at(32) });
  em.persist(effectAttempt);
  await em.flush();
  effectAttempt.markSent(generation, at(32));
  effectAttempt.recordResponse(generation, { responseClass: 'success', httpStatus: 204 }, at(33));
  action.recordOutcome(effectAttempt.id, generation, { classification: 'confirmed', code: 'http_204', httpStatus: 204 }, action.rowRevision, at(33));
  await em.flush();
  em.clear();
  assert.equal((await em.findOneOrFail(ModerationAction, action.id)).state, 'CONFIRMED');
});

test('database rejects cross-guild references, duplicate active installs, and original-content edits', async () => {
  const graph = moderationGraph('900000000000000201');
  const em = orm.em.fork();
  em.persist(graph.records);
  await em.flush();
  await assert.rejects(orm.em.fork().execute('update moderation_case set guild_id = ? where id = ?', ['900000000000000999', graph.caseRecord.id]));
  await assert.rejects(orm.em.fork().execute('update evidence_revision set original_content = ? where id = ?', ['Edited body', graph.evidence.id]));
  await assert.rejects(orm.em.fork().execute('update moderation_action set target_user_id = ? where id = ?', ['900000000000000999', graph.action.id]));
  const duplicate = new GuildInstallation({ guildId: graph.scope.guildId, generation: 2, registeredAt: at(1), createdAt: at(1), featureAdmission: {} });
  const other = orm.em.fork(); other.persist(duplicate);
  await assert.rejects(other.flush());
  const purge = orm.em.fork();
  const evidence = await purge.findOneOrFail(EvidenceRevision, graph.evidence.id);
  evidence.purgePayload(at(1001), 'retention');
  await purge.flush();
  assert.equal((await orm.em.fork().findOneOrFail(EvidenceRevision, graph.evidence.id)).originalContent, null);
});

test('optimistic revisions reject a second writer loaded before the first update', async () => {
  const installed = installation('900000000000000301');
  const seed = orm.em.fork(); seed.persist(installed); await seed.flush();
  const first = orm.em.fork(), second = orm.em.fork();
  const a = await first.findOneOrFail(GuildInstallation, installed.id);
  const b = await second.findOneOrFail(GuildInstallation, installed.id);
  a.suspend('maintenance', at(1)); await first.flush();
  b.suspend('other', at(2));
  await assert.rejects(second.flush(), /optimistic|lock/i);
});
