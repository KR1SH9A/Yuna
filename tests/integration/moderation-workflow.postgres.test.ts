/** Execute the original-evidence workflow with real PostgreSQL runtime roles and injected provider outcomes. */
import assert from 'node:assert/strict';
import { createHash as hashRules } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { AuditEntry } from '../../src/platform/audit/entities/audit-entry.entity.js';
import { LockMode, type FlushEventArgs } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { GuildSafetyState } from '../../src/contexts/administration/entities/guild-safety-state.entity.js';
import { ModerationService } from '../../src/contexts/moderation/moderation.service.js';
import { ModerationWorkflowService } from '../../src/contexts/moderation/moderation-workflow.service.js';
import { ModerationTaskService } from '../../src/platform/jobs/moderation-task.service.js';
import { ModerationWorkerStore } from '../../src/platform/jobs/moderation-worker.store.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { ModerationCase } from '../../src/contexts/moderation/entities/moderation-case.entity.js';
import { ModerationAction } from '../../src/contexts/moderation/entities/moderation-action.entity.js';
import { ModerationFinding } from '../../src/contexts/moderation/entities/moderation-finding.entity.js';
import { EvidenceRevision } from '../../src/contexts/moderation/entities/evidence-revision.entity.js';
import { AiTask } from '../../src/platform/jobs/entities/ai-task.entity.js';
import { TaskAcceptance } from '../../src/platform/jobs/entities/task-acceptance.entity.js';
import { TaskResult } from '../../src/platform/jobs/entities/task-result.entity.js';
import { UsageEntry } from '../../src/platform/usage/entities/usage-entry.entity.js';
import { UsageReservation } from '../../src/platform/usage/entities/usage-reservation.entity.js';
import { defaultYunaPolicy, loadPolicyConfig, validatePolicyConfig } from '../../src/platform/config/policy-config.js';
import type { JsonObject } from '../../src/platform/db/entity-values.js';
import type { ObservationResult } from '../../src/ai/contracts/observation.contracts.js';
import type { AssessmentResult } from '../../src/ai/contracts/assessment.contracts.js';
import type { ModerationWorkerClaim } from '../../src/platform/jobs/moderation-task.contracts.js';

let database: ReturnType<typeof temporaryPostgres>, bot: MikroORM, workerOrm: MikroORM, inspector: MikroORM, worker: ModerationWorkerStore;
let sequence = 2000;
const tasks = new ModerationTaskService();
beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'moderation-bot-test', workerDatabasePassword: 'moderation-worker-test' });
  bot = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false, logger: () => {} });
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false, logger: () => {} });
  inspector = new MikroORM({ ...database.options, entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false, logger: () => {} });
  await Promise.all([bot.connect(), workerOrm.connect(), inspector.connect()]); worker = new ModerationWorkerStore(workerOrm);
}, 60_000);
afterAll(async () => { try { await Promise.all([bot?.close(true), workerOrm?.close(true), inspector?.close(true)]); } finally { database?.close(); } }, 30_000);

/** Publish the selected policy through the owner; unique model selectors keep pending work separate between fixtures. */
async function fixture(options: { starter?: boolean; content?: string } = {}) {
  const administration = new GuildLifecycleService(bot), scope = await administration.registerGuild(String(900000000000000000n + BigInt(sequence++)), 'fake');
  const intake = new IntakeService(), service = new ModerationService(bot, scope, administration, intake);
  const workflow = new ModerationWorkflowService(bot, scope, administration, tasks);
  const config = options.starter
    ? await loadPolicyConfig(new URL('../../../config/yuna.example.json', import.meta.url).pathname,
      { REPLY_MODEL: `observe-${sequence}`, JEV_MODEL: `assess-${sequence}` })
    : validatePolicyConfig({ ...structuredClone(defaultYunaPolicy), moderation: { enabled: true, policy: {
    rules: [{ id: 'abuse', version: '1', description: 'Prohibit the specific original conduct described in the rule.', enabled: true }],
    requiredEvidence: [{ ruleId: 'abuse', originalBody: true, originalMedia: false, establishedAuthor: true }], exclusions: [],
    evaluationConfiguration: { schemaVersion: 1, observationModel: `observe-${sequence}`, assessmentModel: `assess-${sequence}`, promptVersion: 'moderation-v1',
      decisionThresholds: { minimumConfidence: 0.9, yesThreshold: 0.95, noThreshold: 0.05 } },
    actionMapping: [{ ruleId: 'abuse', supportedDisposition: 'violation', action: 'ban', deleteMessageSeconds: 0 },
      { ruleId: 'abuse', supportedDisposition: 'suspicion', action: 'warning', deleteMessageSeconds: 0 }],
  } } });
  if (options.starter) {
    const content = 'Use the proper channel for recruitment.';
    config.moderation.policy!.evaluationConfiguration.serverRules = { schemaVersion: 1, guildId: scope.guildId,
      observedAt: new Date().toISOString(), coverage: 'complete', sources: [{ kind: 'message', channelId: '900000000000000006',
        messageId: '900000000000000007', authorId: '900000000000000002', content, contentHash: hashRules('sha256').update(content).digest('hex') }] };
  }
  const caller = { ...scope, actorId: '900000000000000002', sourceRequestId: `publish-${sequence}` };
  await bot.em.fork().transactional(async em => {
    const installation = await em.findOneOrFail(GuildInstallation, scope.installationId, { lockMode: LockMode.PESSIMISTIC_WRITE }); const now = new Date();
    installation.updateOperatorPolicy(0, config as unknown as JsonObject, now);
    installation.updateFeatureAdmission(installation.rowRevision, { community: 'enabled', moderation: 'enabled' }, now);
    await service.publishPolicy(em, caller, config, now);
  });
  const provenance = { guildId: scope.guildId, channelId: '900000000000000003', messageId: '900000000000000004', eventKind: 'message_create' as const,
    authorKind: 'user' as const, authorUserId: '900000000000000005', webhookId: null, messageType: 0, createdAt: new Date(), observedAt: new Date() };
  const content = options.content ?? 'Explicit original evidence';
  const ingested = await service.ingestMessage(provenance, { originalContent: content, attachments: [], contentAccess: 'available', attachmentsComplete: true, missingReasons: [] });
  assert.equal(ingested.status, 'recorded'); if (ingested.status !== 'recorded') throw new Error('Expected original capture');
  return { administration, scope, intake, service, workflow, config, caller, provenance, content, caseId: ingested.case.caseId, evidenceId: ingested.case.evidenceRevisionId! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Claim/release/start must each succeed once before a provider result is possible. */
async function dispatch(f: Fixture, kind: 'moderation.observe' | 'moderation.assess') {
  const config = f.config.moderation.policy!.evaluationConfiguration;
  const claim = await worker.claimNext(`worker-${f.scope.guildId}`, kind, kind === 'moderation.observe' ? config.observationModel : config.assessmentModel);
  assert.ok(claim); const prepared = await worker.releasePreparedInput(claim); assert.ok(prepared);
  assert.equal(await worker.releasePreparedInput(claim), null);
  assert.equal(await worker.recordProviderStart(claim), true); assert.equal(await worker.recordProviderStart(claim), false);
  return { claim, prepared };
}
/** Provider result fixtures preserve exact locally grounded spans and owner-supplied references. */
function observation(f: Fixture): ObservationResult {
  return { schemaVersion: 1, evidenceRevisionId: f.evidenceId, sourceReferences: [`evidence:${f.evidenceId}`], outcome: 'observed', uncertaintyReason: null,
    inspectedBody: true, facts: [{ statement: f.content, quote: f.content, start: 0, end: f.content.length }], limitations: [],
    providerRequestId: 'observe-request', requestedModel: f.config.moderation.policy!.evaluationConfiguration.observationModel, model: 'observed-provider-model',
    inputTokens: 100, outputTokens: 30, totalTokens: 130 };
}
/** Store the observation under its real worker lease, then let the owner register the assessment. */
async function observe(f: Fixture) {
  assert.equal(await f.workflow.admitCase(f.caseId), 'admitted'); const { claim } = await dispatch(f, 'moderation.observe'); const result = observation(f);
  await worker.recordResult(claim, { outcome: 'success', reason: 'observed', payload: result, providerRequestId: result.providerRequestId,
    usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 } });
  const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!; assert.equal(await f.workflow.acceptResult(reference), 'accepted');
  return claim;
}
/** Well-formed advisory violation; every owner gate still decides whether it creates an intent. */
async function assessment(f: Fixture): Promise<AssessmentResult> {
  const record = await bot.em.fork().findOneOrFail(ModerationCase, { ...f.scope, id: f.caseId });
  return { schemaVersion: 1, configurationVersion: record.policyRevisionId, sourceReferences: [`evidence:${f.evidenceId}`], outcome: 'assessed', uncertaintyReason: null,
    answers: { disposition: { type: 'choice', choice: 'violation', confidence: 0.99, probabilities: { violation: 0.97, suspicion: 0.01, clear: 0.01, incomplete: 0.01 } },
      attributable: { type: 'noul', noul: 0.99 }, excluded: { type: 'noul', noul: 0.01 } },
    requestedModel: f.config.moderation.policy!.evaluationConfiguration.assessmentModel, model: 'jev-provider-model', providerRequestId: null, provider: null,
    inputTokens: 200, outputTokens: 20, totalTokens: 220, costUsd: '0.000000000000000001' };
}
/** Finish one assessment while retaining its exact reported cost, including sub-cent amounts. */
async function finishAssessment(f: Fixture, claim: ModerationWorkerClaim, supplied?: AssessmentResult) {
  const result = supplied ?? await assessment(f);
  return worker.recordResult(claim, { outcome: 'success', reason: 'assessed', payload: result, providerRequestId: result.providerRequestId,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, totalTokens: result.totalTokens, costUsd: result.costUsd } });
}

test('restricted worker cannot read business tables, call internal helpers or execute unknown task kinds', async () => {
  await assert.rejects(workerOrm.em.fork().execute('select * from evidence_revision'));
  await assert.rejects(workerOrm.em.fork().execute('select public.yuna_moderation_gate(gen_random_uuid())'));
  await assert.rejects(workerOrm.em.fork().execute("select public.yuna_moderation_claim('worker','arbitrary','model')"));
});

test('two durable stages accept once and persist finding, exact action authority and reported USD cost', async () => {
  const f = await fixture(); await observe(f); const { claim } = await dispatch(f, 'moderation.assess');
  assert.equal(await finishAssessment(f, claim), 'stored');
  const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!;
  const accepted = await Promise.all([f.workflow.acceptResult(reference), f.workflow.acceptResult(reference)]);
  assert.deepEqual(accepted.sort(), ['accepted', 'already_handled']);
  const action = await bot.em.fork().findOneOrFail(ModerationAction, f.scope, { populate: ['findings'] });
  assert.equal(action.kind, 'ban'); assert.equal(action.state, 'READY'); assert.equal(action.targetUserId, f.provenance.authorUserId);
  assert.equal(action.findings.length, 1); assert.equal(action.evidenceRevisionId, f.evidenceId);
  assert.equal(await bot.em.fork().count(TaskAcceptance, f.scope), 2);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'moderation.result' }), 2);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'moderation.finding' }), 1);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'moderation.intent', outcome: 'intent' }), 1);
  const reservation = await bot.em.fork().findOneOrFail(UsageReservation, { ...f.scope, provider: 'openrouter' });
  assert.equal(reservation.state, 'settled');
  assert.equal((await bot.em.fork().findOneOrFail(UsageEntry, { ...f.scope, reservationId: reservation.id })).actualCost, '0.000000000000000001');
  assert.equal(await finishAssessment(f, claim), 'stale');
  await assert.rejects(finishAssessment(f, claim, { ...await assessment(f), costUsd: '0' }), /Conflicting reported moderation cost/);
});

test('current-source deletion does not revoke retained-original observation or assessment work', async () => {
  const f = await fixture(); assert.equal(await f.workflow.admitCase(f.caseId), 'admitted');
  await bot.em.fork().transactional(async em => {
    await f.administration.lockAdmission(em, f.scope); await f.intake.invalidate(em, f.scope, f.provenance, new Date());
  });
  const { claim } = await dispatch(f, 'moderation.observe'); const result = observation(f);
  assert.equal(await worker.recordResult(claim, { outcome: 'success', reason: 'observed', payload: result,
    usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 } }), 'stored');
  const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!; assert.equal(await f.workflow.acceptResult(reference), 'accepted');
  assert.equal((await bot.em.fork().findOneOrFail(ModerationCase, f.scope)).workflowPhase, 'assessing');
});

test('policy replacement wins before release and owner acknowledgment discards the canceled result', async () => {
  const f = await fixture(); assert.equal(await f.workflow.admitCase(f.caseId), 'admitted');
  const claim = await worker.claimNext('policy-worker', 'moderation.observe', f.config.moderation.policy!.evaluationConfiguration.observationModel); assert.ok(claim);
  const replacement = structuredClone(f.config); replacement.moderation.policy!.rules[0]!.version = '2';
  await bot.em.fork().transactional(async em => {
    await f.administration.lockFeatureAdmission(em, f.scope, 'moderation'); await f.service.publishPolicy(em, f.caller, replacement, new Date());
  });
  assert.equal(await worker.releasePreparedInput(claim), null); assert.equal(await worker.recordProviderStart(claim), false);
  await tasks.recoverExpired(bot.em.fork());
  const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!; assert.equal(await f.workflow.acceptResult(reference), 'discarded');
  assert.equal(await bot.em.fork().count(ModerationAction, f.scope), 0);
  assert.equal((await bot.em.fork().findOneOrFail(UsageReservation, f.scope)).state, 'released');
});

test('safety change after provider start rejects meaning while retaining late exact accounting and never retrying', async () => {
  const f = await fixture(); await observe(f); const { claim } = await dispatch(f, 'moderation.assess');
  await bot.em.fork().transactional(async em => {
    await f.administration.lockFeatureAdmission(em, f.scope, 'moderation'); const safety = await em.findOneOrFail(GuildSafetyState, f.scope);
    safety.pause(safety.safetyRevision, { kind: 'system', operation: 'test-pause' }, 'test_pause', new Date());
  });
  assert.equal(await finishAssessment(f, claim), 'stale');
  const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!; assert.equal(await f.workflow.acceptResult(reference), 'discarded');
  assert.equal(await bot.em.fork().count(ModerationAction, f.scope), 0);
  assert.equal(await worker.claimNext('retry', 'moderation.assess', f.config.moderation.policy!.evaluationConfiguration.assessmentModel), null);
  assert.equal((await bot.em.fork().findOneOrFail(UsageReservation, { ...f.scope, provider: 'openrouter' })).state, 'settled');
});

test('fake uncertainty and unsupported quoted facts cannot progress to sanctions', async () => {
  for (const variant of ['fake', 'invented'] as const) {
    const f = await fixture(); await f.workflow.admitCase(f.caseId); const { claim } = await dispatch(f, 'moderation.observe');
    const result = observation(f);
    const changed = variant === 'fake' ? { ...result, outcome: 'uncertain' as const, uncertaintyReason: 'fake_provider' as const,
      inspectedBody: false, facts: [], limitations: ['fake_provider'] } : { ...result, facts: [{ statement: 'invented', quote: f.content, start: 0, end: f.content.length }] };
    await worker.recordResult(claim, { outcome: 'success', reason: 'observed', payload: changed,
      usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 } });
    const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!;
    assert.equal(await f.workflow.acceptResult(reference), 'discarded');
    assert.equal((await bot.em.fork().findOneOrFail(ModerationCase, f.scope)).disposition, 'incomplete');
    assert.equal(await bot.em.fork().count(ModerationAction, f.scope), 0);
    assert.equal(await bot.em.fork().count(AiTask, { ...f.scope, kind: 'moderation.assess' }), 0);
  }
});

test('post-flush acceptance error rolls finding/action/ack back while stored assessment remains recoverable', async () => {
  const f = await fixture(); await observe(f); const { claim } = await dispatch(f, 'moderation.assess'); await finishAssessment(f, claim);
  const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!; let failed = false;
  bot.em.getEventManager().registerSubscriber({ /** Inject a failure after ORM flush so the test verifies that the entire transaction rolls back. */ afterFlush(args: FlushEventArgs) {
    if (!failed && args.uow.getChangeSets().some(change => change.entity instanceof ModerationFinding && change.entity.installationId === f.scope.installationId)) {
      failed = true; throw new Error('after finding flush');
    }
  } });
  await assert.rejects(f.workflow.acceptResult(reference), /after finding flush/);
  assert.equal(await bot.em.fork().count(ModerationFinding, f.scope), 0); assert.equal(await bot.em.fork().count(ModerationAction, f.scope), 0);
  assert.equal(await bot.em.fork().count(TaskAcceptance, { ...f.scope, resultId: reference.resultId }), 0);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: { $in: ['moderation.finding', 'moderation.intent'] } }), 0);
  assert.equal((await bot.em.fork().findOneOrFail(TaskResult, { ...f.scope, id: reference.resultId })).outcome, 'success');
  assert.equal(await f.workflow.acceptResult(reference), 'accepted');
});

test('retention before release fences disclosure and ordinary duplicate create cannot restore erased evidence', async () => {
  const f = await fixture(); await f.workflow.admitCase(f.caseId);
  const claim = await worker.claimNext('retention-worker', 'moderation.observe', f.config.moderation.policy!.evaluationConfiguration.observationModel); assert.ok(claim);
  await bot.em.fork().transactional(async em => {
    await f.administration.lockFeatureAdmission(em, f.scope, 'moderation'); await f.service.runRetention(em, new Date(Date.now() + 31 * 86400_000));
  });
  assert.equal(await worker.releasePreparedInput(claim), null); assert.equal((await bot.em.fork().findOneOrFail(EvidenceRevision, f.scope)).originalContent, null);
});

test('multiple configured rules share one observation, persist sequential findings and select one final strongest action', async () => {
  const f = await fixture(), changed = structuredClone(f.config);
  changed.moderation.policy!.rules.push({ id: 'second', version: '1', description: 'Second configured conduct rule.', enabled: true });
  changed.moderation.policy!.requiredEvidence.push({ ruleId: 'second', originalBody: true, originalMedia: false, establishedAuthor: true });
  changed.moderation.policy!.actionMapping.push({ ruleId: 'second', supportedDisposition: 'violation', action: 'ban', deleteMessageSeconds: 60 });
  await bot.em.fork().transactional(async em => {
    await f.administration.lockFeatureAdmission(em, f.scope, 'moderation');
    const installation = await em.findOneOrFail(GuildInstallation, f.scope.installationId); const now = new Date();
    installation.updateOperatorPolicy(installation.policyRevision, changed as unknown as JsonObject, now);
    await f.service.publishPolicy(em, f.caller, changed, now);
  });
  await observe(f);
  const first = await dispatch(f, 'moderation.assess'); await finishAssessment(f, first.claim);
  let reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!;
  assert.equal(await f.workflow.acceptResult(reference), 'accepted');
  assert.equal(await bot.em.fork().count(ModerationFinding, f.scope), 1);
  assert.equal(await bot.em.fork().count(ModerationAction, f.scope), 0);
  assert.equal((await bot.em.fork().findOneOrFail(ModerationCase, f.scope)).workflowPhase, 'assessing');
  const second = await dispatch(f, 'moderation.assess'); await finishAssessment(f, second.claim);
  reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!;
  assert.equal(await f.workflow.acceptResult(reference), 'accepted');
  const action = await bot.em.fork().findOneOrFail(ModerationAction, f.scope, { populate: ['findings'] });
  assert.equal(action.kind, 'ban'); assert.equal(action.findings.length, 1);
  assert.equal(await bot.em.fork().count(ModerationFinding, f.scope), 2);
  assert.equal(action.operationPayload?.kind === 'ban' ? action.operationPayload.deleteMessageSeconds : -1, 60);
  assert.equal(await bot.em.fork().count(AiTask, { ...f.scope, kind: 'moderation.observe' }), 1);
  assert.equal(await bot.em.fork().count(AiTask, { ...f.scope, kind: 'moderation.assess' }), 2);
  assert.equal(await bot.em.fork().count(TaskAcceptance, f.scope), 3);
});

test.each([true, false])('automatic moderation chooses one ban only when severe harm and proportionality are established (%s)', async severe => {
  const f = await fixture({ starter: true, content: 'Original conduct for a controlled assessment fixture.' });
  const configured = f.config.moderation.policy!;
  assert.deepEqual(configured.rules.map(rule => rule.id), ['community_conduct', 'severe_harm']);
  await observe(f);
  for (const [index, rule] of configured.rules.entries()) {
    const { claim, prepared } = await dispatch(f, 'moderation.assess');
    assert.equal(prepared.kind, 'moderation.assess'); if (prepared.kind !== 'moderation.assess') throw new Error('Expected starter assessment');
    assert.deepEqual(prepared.input.state.rule, { id: rule.id, version: rule.version, description: rule.description });
    assert.equal(prepared.input.state.originalBody, f.content);
    assert.equal(prepared.input.state.sourceChannelId, f.provenance.channelId);
    assert.deepEqual(prepared.input.state.serverGuidance, configured.evaluationConfiguration.serverRules);
    if (rule.id === 'severe_harm') assert.equal(prepared.input.questions.banNecessary?.type, 'noul');
    const result = await assessment(f);
    const judged: AssessmentResult = { ...result, answers: { ...result.answers,
      disposition: { type: 'choice', choice: 'violation', confidence: 0.99,
        probabilities: { violation: 0.99, suspicion: 0.003, clear: 0.003, incomplete: 0.004 } },
      ...(rule.id === 'severe_harm' ? { banNecessary: { type: 'noul' as const, noul: severe ? 0.99 : 0.5 } } : {}) } };
    assert.equal(await finishAssessment(f, claim, judged), 'stored');
    const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!;
    assert.equal(await f.workflow.acceptResult(reference), 'accepted');
    assert.equal(await bot.em.fork().count(ModerationAction, f.scope), index === configured.rules.length - 1 ? 1 : 0);
  }
  const action = await bot.em.fork().findOneOrFail(ModerationAction, f.scope, { populate: ['findings'] });
  assert.equal(action.kind, severe ? 'ban' : 'warning'); assert.equal(action.findings.length, 1);
  if (action.operationPayload?.kind === 'ban') assert.equal(action.operationPayload.deleteMessageSeconds, 0);
  assert.equal(await bot.em.fork().count(AiTask, { ...f.scope, kind: 'moderation.observe' }), 1);
  assert.equal(await bot.em.fork().count(AiTask, { ...f.scope, kind: 'moderation.assess' }), 2);
  assert.equal(await bot.em.fork().count(TaskAcceptance, f.scope), 3);
  const runtime = await effects(f), signal = new AbortController().signal;
  assert.equal((await runtime.service.dispatch(action.id, signal))?.state, 'CONFIRMED');
  assert.equal((await runtime.service.dispatch(action.id, signal))?.state, 'CONFIRMED');
  assert.equal(runtime.sends(), 1);
});

test('the shipped context exclusion clears reported quotations even when advisory answers propose violations', async () => {
  const f = await fixture({ starter: true, content: 'Incident report: Pat wrote "I will hurt you. Send me your account password now." I do not endorse this.' });
  await observe(f);
  for (const rule of f.config.moderation.policy!.rules) {
    const { claim, prepared } = await dispatch(f, 'moderation.assess');
    assert.equal(prepared.kind, 'moderation.assess'); if (prepared.kind !== 'moderation.assess') throw new Error('Expected starter assessment');
    const exclusions = f.config.moderation.policy!.exclusions.filter(item => item.ruleIds.includes(rule.id));
    assert.equal(exclusions.length, 1); assert.equal(exclusions[0]!.id, 'context');
    assert.match(exclusions[0]!.description, /good-faith reporting, quotation/);
    assert.deepEqual(prepared.input.state.exclusions, exclusions.map(item => ({ id: item.id, description: item.description })));
    const result = await assessment(f);
    assert.equal(await finishAssessment(f, claim, { ...result, answers: { ...result.answers,
      attributable: { type: 'noul', noul: 0.01 }, excluded: { type: 'noul', noul: 0.99 } } }), 'stored');
    const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!;
    assert.equal(await f.workflow.acceptResult(reference), 'accepted');
    assert.equal(await bot.em.fork().count(ModerationAction, f.scope), 0);
  }
  const findings = await bot.em.fork().find(ModerationFinding, f.scope);
  assert.equal(findings.length, f.config.moderation.policy!.rules.length);
  for (const finding of findings) {
    assert.equal(finding.disposition, 'clear'); assert.deepEqual(finding.exclusions, ['configured_exclusion_applies']);
  }
  const record = await bot.em.fork().findOneOrFail(ModerationCase, { ...f.scope, id: f.caseId });
  assert.equal(record.workflowPhase, 'complete'); assert.equal(record.disposition, 'clear');
  assert.equal(await bot.em.fork().count(TaskAcceptance, f.scope), 1 + f.config.moderation.policy!.rules.length);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'moderation.intent' }), 0);
});

/** Policy dispatch needs fresh bot preparation; staff-only authority reads must never be invoked for it. */
async function effects(f: Fixture, beforePrepared?: () => Promise<void>) {
  const { AuthorityService } = await import('../../src/contexts/administration/authority.service.js');
  const { SafetyService } = await import('../../src/contexts/administration/safety.service.js');
  const { ActionExecutionService } = await import('../../src/contexts/moderation/action-execution.service.js');
  const authority = new AuthorityService(bot, { /** Supply deterministic native authority facts; no real Discord permissions are consulted. */ async readFacts() { throw new Error('Policy cannot fabricate staff authority'); } }, async () => {});
  const safety = new SafetyService(bot, authority, async () => {}); let sends = 0;
  const service = new ActionExecutionService(bot, f.scope, authority, safety, f.administration, {
    /** Supply deterministic effect preparation and fresh authority facts before dispatch. */
    async prepare(input) {
      await beforePrepared?.();
      return { actionId: input.actionId, guildId: input.guildId, targetUserId: input.targetUserId, kind: input.operation.kind,
        observedAt: new Date(), complete: true, permitted: true, channelId: input.operation.kind === 'warning' ? '900000000000000008' : null };
    },
    /** Capture the exact requested moderation effect without contacting Discord. */
    async execute(input) { sends++; return { classification: 'confirmed', code: 'http_success', httpStatus: input.operation.kind === 'warning' ? 200 : 204,
      ...(input.operation.kind === 'warning' ? { discordMessageId: '900000000000000009' } : {}) }; },
    /** Return the fixture's attributable remote outcome without repeating the effect. */
    async reconcile() { return null; },
  });
  return { service, sends: () => sends };
}

/** Complete both provider stages to obtain an owner-created durable policy intent. */
async function acceptedAction(f: Fixture, kind: 'ban' | 'warning' = 'ban') {
  await observe(f); const { claim } = await dispatch(f, 'moderation.assess'); let result = await assessment(f);
  if (kind === 'warning') result = { ...result, answers: { ...result.answers, disposition: { type: 'choice', choice: 'suspicion', confidence: 0.99,
    probabilities: { violation: 0.01, suspicion: 0.97, clear: 0.01, incomplete: 0.01 } } } };
  await finishAssessment(f, claim, result);
  const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!; assert.equal(await f.workflow.acceptResult(reference), 'accepted');
  return bot.em.fork().findOneOrFail(ModerationAction, f.scope);
}

test('owner-accepted real findings dispatch one policy ban or warning through the durable effect claim', async () => {
  for (const kind of ['ban', 'warning'] as const) {
    const f = await fixture(), action = await acceptedAction(f, kind), runtime = await effects(f), signal = new AbortController().signal;
    assert.equal(action.kind, kind);
    assert.equal((await runtime.service.dispatch(action.id, signal))?.state, 'CONFIRMED');
    assert.equal((await runtime.service.dispatch(action.id, signal))?.state, 'CONFIRMED');
    assert.equal(runtime.sends(), 1);
  }
});

test('policy publication or original-evidence erasure during preparation cancels the accepted intent before dispatch', async () => {
  for (const change of ['policy', 'evidence'] as const) {
    const f = await fixture(), action = await acceptedAction(f);
    const runtime = await effects(f, async () => {
      await bot.em.fork().transactional(async em => {
        await f.administration.lockFeatureAdmission(em, f.scope, 'moderation');
        if (change === 'policy') {
          const updated = structuredClone(f.config); updated.moderation.policy!.rules[0]!.version = '2';
          await f.service.publishPolicy(em, f.caller, updated, new Date());
        } else {
          const original = await em.findOneOrFail(EvidenceRevision, { ...f.scope, id: f.evidenceId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
          original.purgePayload(new Date(), 'privacy_request');
        }
      });
    });
    assert.equal((await runtime.service.dispatch(action.id, new AbortController().signal))?.state, 'CANCELED');
    assert.equal(runtime.sends(), 0);
  }
});

 test('retention cancels and audits an automatic ready intent exactly once before erasing payload', async () => {
  const f = await fixture(); await observe(f); const { claim } = await dispatch(f, 'moderation.assess'); await finishAssessment(f, claim);
  const reference = (await tasks.pendingResults(bot.em.fork(), f.scope))[0]!; await f.workflow.acceptResult(reference);
  const action = await bot.em.fork().findOneOrFail(ModerationAction, f.scope);
  const at = new Date(action.purgeAfter.getTime() + 1000);
  for (let run = 0; run < 2; run++) await bot.em.fork().transactional(async em => {
    await f.administration.lockPrivacy(em, f.scope); await f.service.runRetention(em, at);
  });
  assert.equal((await bot.em.fork().findOneOrFail(ModerationAction, action.id)).state, 'CANCELED');
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'moderation.cancellation', outcome: 'canceled' }), 1);
});
