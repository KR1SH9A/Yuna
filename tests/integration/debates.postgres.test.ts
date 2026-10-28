/** Exercise consent, frozen Jev tasks, atomic acceptance and publication using actual restricted PostgreSQL roles. */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from '@jest/globals';
import { LockMode, type FlushEventArgs } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { GuildSafetyState } from '../../src/contexts/administration/entities/guild-safety-state.entity.js';
import { DebateService } from '../../src/contexts/debates/debate.service.js';
import { DebatePublicationService } from '../../src/contexts/debates/debate-publication.service.js';
import { DebateSession } from '../../src/contexts/debates/entities/debate-session.entity.js';
import { DebateEvaluation } from '../../src/contexts/debates/entities/debate-evaluation.entity.js';
import { ParticipantConsent } from '../../src/contexts/debates/entities/participant-consent.entity.js';
import { TranscriptEntry } from '../../src/contexts/debates/entities/transcript-entry.entity.js';
import { TranscriptSnapshot } from '../../src/contexts/debates/entities/transcript-snapshot.entity.js';
import { RubricRevision } from '../../src/contexts/debates/entities/rubric-revision.entity.js';
import { DebateWorkerStore } from '../../src/platform/jobs/debate-worker.store.js';
import { AiTask } from '../../src/platform/jobs/entities/ai-task.entity.js';
import { PreparedInput } from '../../src/platform/jobs/entities/prepared-input.entity.js';
import { TaskAcceptance } from '../../src/platform/jobs/entities/task-acceptance.entity.js';
import { UsageReservation } from '../../src/platform/usage/entities/usage-reservation.entity.js';
import { UsageEntry } from '../../src/platform/usage/entities/usage-entry.entity.js';
import { AuditEntry } from '../../src/platform/audit/entities/audit-entry.entity.js';
import type { AssessmentInput, AssessmentResult } from '../../src/ai/contracts/assessment.contracts.js';
import type { DebatePublicationTransport } from '../../src/contexts/debates/contracts.js';
import type { ScopedEntity } from '../../src/platform/db/base.entity.js';

let database: ReturnType<typeof temporaryPostgres>, bot: MikroORM, workerOrm: MikroORM, worker: DebateWorkerStore;
let serial = 0;
const first = '910000000000000001', second = '910000000000000002', outsider = '910000000000000003', channelId = '910000000000000004';
beforeAll(async () => {
  database = temporaryPostgres(); const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'debate-bot-test', workerDatabasePassword: 'debate-worker-test' });
  bot = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false });
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false });
  await Promise.all([bot.connect(), workerOrm.connect()]); worker = new DebateWorkerStore(workerOrm);
}, 60000);
afterAll(async () => { try { await Promise.all([bot?.close(true), workerOrm?.close(true)]); } finally { database?.close(); } }, 30000);

/** Each scenario has a unique model, installation and trusted request sequence. */
async function fixture(paired = false) {
  const lifecycle = new GuildLifecycleService(bot), scope = await lifecycle.registerGuild(String(920000000000000000n + BigInt(++serial)), 'test-model');
  const model = `debate-test-${serial}`, service = new DebateService(bot, scope, lifecycle, model); let requests = 0;
  /** Produce authenticated caller identity independently from the command arguments. */
  const caller = (actorId = first) => ({ ...scope, actorId, sourceRequestId: `debate:${scope.guildId}:${++requests}` });
  await bot.em.fork().transactional(async em => {
    const row = await em.findOneOrFail(GuildInstallation, scope.installationId, { lockMode: LockMode.PESSIMISTIC_WRITE });
    row.updateFeatureAdmission(row.rowRevision, { ...row.featureAdmission, debates: 'enabled' }, new Date());
  });
  const proposal = { channelId, opponentUserId: second, topic: 'Compare the submitted arguments.', retentionSeconds: 3600,
    rubric: { criteria: [{ id: 'evidence', description: 'Evidence quality', levels: ['Absent', 'Partial', 'Supported'], weight: '0.1' }],
      minimumWinningMargin: '0.05', minimumConfidence: 0.9, paired, maximumPairDifference: 0 } };
  const session = await service.proposeSession(caller(), proposal);
  return { scope, lifecycle, model, service, caller, session, proposal };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Both actual invitees consent, start, and submit their own text before a freeze is allowed. */
async function start(f: Fixture) {
  for (const user of [first, second]) await f.service.recordConsent(f.caller(user), { sessionId: f.session.sessionId, scopeHash: f.session.scopeHash, accept: true });
  await f.service.startSession(f.caller(), { sessionId: f.session.sessionId });
  await f.service.appendEntry(f.caller(), { sessionId: f.session.sessionId, text: 'The first argument has documented evidence.' });
  await f.service.appendEntry(f.caller(second), { sessionId: f.session.sessionId, text: 'The second argument has partial evidence.' });
}
/** Supply validated typed scores while mapping aliases back consistently in reversed-speaker tasks. */
function assessment(input: AssessmentInput, model: string, fake = false): AssessmentResult {
  const favoredSpeaker = (input.state.transcript as { speaker: string }[])[0]!.speaker === 'speaker_1' ? 0 : 1;
  const answers: Record<string, AssessmentResult['answers'][string]> = { sufficient: { type: 'noul', noul: 1 } };
  for (const [key, question] of Object.entries(input.questions)) if (question.type === 'score') {
    const score = key.endsWith(`s${favoredSpeaker}`) ? 2 : 1;
    answers[key] = { type: 'score', score, confidence: 1, probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === score ? 1 : 0])),
      legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])) };
  }
  return { schemaVersion: 1, configurationVersion: input.configurationVersion, sourceReferences: input.sourceReferences,
    outcome: fake ? 'uncertain' : 'assessed', uncertaintyReason: fake ? 'fake_provider' : null, answers, requestedModel: model, model,
    providerRequestId: 'debate-provider', provider: 'test', inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: '0.000000000000000001' };
}
/** Execute one actual SQL claim/disclosure/start/result path and return immutable identities. */
async function finishOne(f: Fixture, fake = false) {
  const claim = await worker.claimNext('debate-worker', f.model); assert.ok(claim);
  const prepared = await worker.releasePreparedInput(claim); assert.ok(prepared); assert.equal(await worker.releasePreparedInput(claim), null);
  assert.equal(await worker.recordProviderStart(claim), true); assert.equal(await worker.recordProviderStart(claim), false);
  const payload = assessment(prepared.input, f.model, fake);
  const outcome = { outcome: 'success' as const, reason: 'assessment_completed', payload, providerRequestId: payload.providerRequestId,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: payload.costUsd } };
  assert.equal(await worker.recordResult(claim, outcome), 'stored'); return { claim, outcome };
}
/** Fully accept a stored evaluation so later tests exercise publication rather than fabricated owner records. */
async function accepted(f: Fixture) {
  await start(f); await f.service.freezeTranscript(f.caller(), { sessionId: f.session.sessionId }); await finishOne(f);
  if (f.proposal.rubric.paired) await finishOne(f);
  assert.equal(await f.service.acceptEvaluation(f.session.sessionId), true);
  return bot.em.fork().findOneOrFail(DebateEvaluation, f.scope);
}
/** Provide a transport whose sends and reconciliation results are controlled without any real Discord I/O. */
function publisher(f: Fixture, options: { prepare?: () => Promise<void>; send?: () => Promise<void>; unknown?: boolean; found?: boolean } = {}) {
  let sends = 0;
  const transport: DebatePublicationTransport = {
    /** Simulate a fresh permitted destination and allow deterministic revocation during preflight. */
    async prepare() { await options.prepare?.(); return { allowed: true, observedAt: new Date() }; },
    /** Count the one allowed dispatch before a delayed or ambiguous response. */
    async send() { sends++; await options.send?.(); return options.unknown ? { classification: 'unknown', code: 'connection_lost' } : { classification: 'confirmed', messageId: '930000000000000001' }; },
    /** Missing lookup evidence never proves a message was not sent. */
    async reconcile() { return options.found ? '930000000000000001' : null; },
  };
  return { service: new DebatePublicationService(bot, f.scope, f.lifecycle, f.service, transport), sends: () => sends };
}

test('worker has no direct Debate reads or private helper access', async () => {
  await assert.rejects(workerOrm.em.fork().execute('select * from transcript_entry'), /permission denied/);
  await assert.rejects(workerOrm.em.fork().execute("select public.yuna_debate_gate('00000000-0000-0000-0000-000000000001')"), /permission denied/);
  await assert.rejects(bot.em.fork().execute("select public.yuna_debate_claim('bot','model')"), /permission denied/);
});
test('proposal and invitation are not consent, and outsiders cannot read or submit', async () => {
  const f = await fixture(); assert.deepEqual(f.session.consentedUserIds, []);
  await assert.rejects(f.service.startSession(f.caller(), { sessionId: f.session.sessionId }), /Every Debate participant/);
  await assert.rejects(f.service.recordConsent(f.caller(), { sessionId: f.session.sessionId, scopeHash: 'a'.repeat(64), accept: true }), /scope changed/);
  await assert.rejects(f.service.readSession(f.caller(outsider), { sessionId: f.session.sessionId }), /participant/);
  await start(f); await assert.rejects(f.service.appendEntry(f.caller(outsider), { sessionId: f.session.sessionId, text: 'spectator instructions' }), /participant/);
  const other = await fixture(); await assert.rejects(f.service.readSession(other.caller(), { sessionId: f.session.sessionId }), /installation/);
});
test('concurrent duplicate submission is stored once and freezing binds the complete declared ordered text', async () => {
  const f = await fixture(); await start(f); const caller = f.caller(), input = { sessionId: f.session.sessionId, text: 'A final explicit point.' };
  const [one, two] = await Promise.all([f.service.appendEntry(caller, input), f.service.appendEntry(caller, input)]); assert.deepEqual(one, two);
  assert.equal(await bot.em.fork().count(TranscriptEntry, f.scope), 3);
  await assert.rejects(f.service.appendEntry(caller, { ...input, text: 'Changed replay' }), /replay mismatch/);
  const [a, b] = await Promise.all([f.service.freezeTranscript(f.caller(), { sessionId: f.session.sessionId }), f.service.freezeTranscript(f.caller(second), { sessionId: f.session.sessionId })]);
  assert.equal(a.transcriptId, b.transcriptId); assert.equal(await bot.em.fork().count(AiTask, f.scope), 1);
  await assert.rejects(f.service.appendEntry(f.caller(), input), /not accepting/);
});
test('paired evaluations require both exact variants and concurrent acceptors create one owner result and two acknowledgments', async () => {
  const f = await fixture(true); await start(f); await f.service.freezeTranscript(f.caller(), { sessionId: f.session.sessionId });
  await finishOne(f); assert.equal(await f.service.acceptEvaluation(f.session.sessionId), false); const finished = await finishOne(f);
  const outcomes = await Promise.all([f.service.acceptEvaluation(f.session.sessionId), f.service.acceptEvaluation(f.session.sessionId)]);
  assert.deepEqual(outcomes.sort(), [false, true]); assert.equal(await bot.em.fork().count(DebateEvaluation, f.scope), 1);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'debates.evaluation' }), 1);
  assert.equal(await bot.em.fork().count(TaskAcceptance, f.scope), 2);
  const result = await f.service.readResult(f.caller(), { sessionId: f.session.sessionId }); assert.deepEqual(result.totals, { [first]: '0.2', [second]: '0.1' });
  assert.equal(result.publicationState, 'pending'); assert.equal(await worker.recordResult(finished.claim, finished.outcome), 'stale');
  const costs = await bot.em.fork().find(UsageEntry, f.scope); assert.equal(costs.length, 2); assert(costs.every(row => row.actualCost === '0.000000000000000001'));
});
test('withdrawal works while paused/disabled and immediately blocks prepared disclosure, new writes and restored consent', async () => {
  const f = await fixture(); await start(f); await f.service.freezeTranscript(f.caller(), { sessionId: f.session.sessionId });
  const claim = await worker.claimNext('withdraw-before-release', f.model); assert.ok(claim);
  await bot.em.fork().transactional(async em => { const row = await em.findOneOrFail(GuildInstallation, f.scope.installationId); row.updateFeatureAdmission(row.rowRevision, { ...row.featureAdmission, debates: 'disabled' }, new Date());
    const safety = await em.findOneOrFail(GuildSafetyState, f.scope); safety.pause(safety.safetyRevision, { kind: 'system', operation: 'test' }, 'test_pause', new Date()); });
  await f.service.recordConsent(f.caller(second), { sessionId: f.session.sessionId, scopeHash: f.session.scopeHash, accept: false });
  assert.equal(await worker.releasePreparedInput(claim), null); await f.service.runMaintenance();
  assert((await bot.em.fork().find(TranscriptEntry, f.scope)).every(row => row.content === null));
  assert.equal((await bot.em.fork().findOneOrFail(RubricRevision, f.scope)).criteria, null);
  assert.equal((await bot.em.fork().findOneOrFail(PreparedInput, f.scope)).payload, null);
  await assert.rejects(f.service.appendEntry(f.caller(), { sessionId: f.session.sessionId, text: 'late' }));
  await assert.rejects(f.service.recordConsent(f.caller(second), { sessionId: f.session.sessionId, scopeHash: f.session.scopeHash, accept: true }));
  assert.equal((await bot.em.fork().findOneOrFail(UsageReservation, f.scope)).state, 'released');
});
test('withdrawal after provider start preserves late actual cost without accepting scores or retrying', async () => {
  const f = await fixture(); await start(f); await f.service.freezeTranscript(f.caller(), { sessionId: f.session.sessionId });
  const claim = await worker.claimNext('withdraw-after-start', f.model); assert.ok(claim); const prepared = await worker.releasePreparedInput(claim); assert.ok(prepared);
  assert.equal(await worker.recordProviderStart(claim), true); const payload = assessment(prepared.input, f.model);
  await f.service.recordConsent(f.caller(second), { sessionId: f.session.sessionId, scopeHash: f.session.scopeHash, accept: false });
  assert.equal(await worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: payload.costUsd } }), 'stale');
  await f.service.runMaintenance(); assert.equal(await bot.em.fork().count(DebateEvaluation, f.scope), 0);
  assert.equal((await bot.em.fork().findOneOrFail(UsageEntry, f.scope)).actualCost, payload.costUsd); assert.equal(await worker.claimNext('retry', f.model), null);
});
test('fake assessments yield an explicit uncertain evaluation with no invented totals or winner', async () => {
  const f = await fixture(); await start(f); await f.service.freezeTranscript(f.caller(), { sessionId: f.session.sessionId }); await finishOne(f, true);
  assert.equal(await f.service.acceptEvaluation(f.session.sessionId), true); const result = await f.service.readResult(f.caller(), { sessionId: f.session.sessionId });
  assert.deepEqual(result.outcome, { kind: 'uncertain' }); assert.deepEqual(result.totals, {}); assert.deepEqual(result.scores, []);
});
test('post-flush failure rolls back evaluation, session transition and all task acknowledgments', async () => {
  const f = await fixture(); await start(f); await f.service.freezeTranscript(f.caller(), { sessionId: f.session.sessionId }); await finishOne(f); let failed = false;
  bot.em.getEventManager().registerSubscriber({ /** Fail after actual SQL writes, then allow the stored result to be accepted again. */ afterFlush(args: FlushEventArgs) {
    if (!failed && args.uow.getChangeSets().some(change => change.entity instanceof DebateEvaluation && change.entity.installationId === f.scope.installationId)) { failed = true; throw new Error('debate acceptance rollback'); }
  } });
  await assert.rejects(f.service.acceptEvaluation(f.session.sessionId), /acceptance rollback/);
  assert.equal(await bot.em.fork().count(DebateEvaluation, f.scope), 0); assert.equal(await bot.em.fork().count(TaskAcceptance, f.scope), 0);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'debates.evaluation' }), 0);
  assert.equal((await bot.em.fork().findOneOrFail(DebateSession, f.scope)).state, 'evaluating'); assert.equal(await f.service.acceptEvaluation(f.session.sessionId), true);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'debates.evaluation' }), 1);
});
test('publication rechecks withdrawal after external preparation and prevents the send', async () => {
  const f = await fixture(), evaluation = await accepted(f);
  const p = publisher(f, { /** Withdraw after transport preflight but before the publication claim transaction. */ prepare: async () => { await f.service.recordConsent(f.caller(second), { sessionId: f.session.sessionId, scopeHash: f.session.scopeHash, accept: false }); } });
  await p.service.dispatch(evaluation.id, new AbortController().signal); assert.equal(p.sends(), 0);
  assert.equal((await bot.em.fork().findOneOrFail(DebateEvaluation, { ...f.scope, id: evaluation.id })).publicationState, 'canceled');
});
test('parallel publishers send once and unknown publication is reconciled without blind resend', async () => {
  const f = await fixture(), evaluation = await accepted(f); const signal = new AbortController().signal;
  let release!: () => void, waiting = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  /** Both independent publishers finish preflight before either can claim the database intent. */
  const prepare = async () => { if (++waiting === 2) release(); await barrier; };
  const p = publisher(f, { unknown: true, prepare }), other = publisher(f, { unknown: true, prepare });
  await Promise.all([p.service.dispatch(evaluation.id, signal), other.service.dispatch(evaluation.id, signal)]); assert.equal(p.sends() + other.sends(), 1);
  await p.service.dispatch(evaluation.id, signal); await p.service.reconcile(evaluation.id, signal); assert.equal(p.sends() + other.sends(), 1);
  assert.equal((await bot.em.fork().findOneOrFail(DebateEvaluation, f.scope)).publicationState, 'unknown');
  await f.service.recordConsent(f.caller(second), { sessionId: f.session.sessionId, scopeHash: f.session.scopeHash, accept: false });
  const recover = publisher(f, { found: true }); await recover.service.reconcile(evaluation.id, signal);
  const row = await bot.em.fork().findOneOrFail(DebateEvaluation, f.scope); assert.equal(row.publicationState, 'published'); assert.equal(row.criterionScores, null); assert.equal(recover.sends(), 0);
});
test('ordinary expiry and installation removal erase transcript, rubric, evaluation and prepared copies', async () => {
  const f = await fixture(), evaluation = await accepted(f);
  assert.equal(await bot.em.fork().transactional(em => f.service.runRetention(em, new Date(Date.parse(f.session.purgeAfter) + 1))), 1);
  for (const row of await bot.em.fork().find(TranscriptEntry, f.scope)) assert.equal(row.content, null);
  assert.equal((await bot.em.fork().findOneOrFail(TranscriptSnapshot, f.scope)).orderedEntryIds, null);
  assert.equal((await bot.em.fork().findOneOrFail(DebateEvaluation, { ...f.scope, id: evaluation.id })).totals, null);
  assert.equal(await bot.em.fork().count(ParticipantConsent, f.scope), 2);
  assert.equal((await bot.em.fork().transactional(em => f.service.cleanupForRemoval(em))).disposition, 'retained');
});

test('each variant consumes the initiating participant quota and never charges the invited opponent', async () => {
  const f = await fixture(true); await start(f); await f.service.freezeTranscript(f.caller(), { sessionId: f.session.sessionId });
  await bot.em.fork().execute(`insert into user_usage_limit(guild_id,user_id,installation_id,daily_attempt_limit,daily_budget,currency,updated_at)
    values(?,?,?,1,null,null,clock_timestamp())`, [f.scope.guildId, first, f.scope.installationId]);
  const claim = await worker.claimNext('payer-one', f.model); assert.ok(claim);
  assert.equal(await worker.claimNext('payer-over-limit', f.model), null);
  const row = await bot.em.fork().findOneOrFail(UsageReservation, f.scope); assert.equal(row.policySnapshot.userId, first);
  assert.equal(f.session.payerUserId, first);
  await bot.em.fork().execute('update user_usage_limit set daily_attempt_limit=2 where guild_id=? and user_id=?', [f.scope.guildId, first]);
  assert.ok(await worker.claimNext('payer-two', f.model));
  assert((await bot.em.fork().find(UsageReservation, f.scope)).every(reservation => reservation.policySnapshot.userId === first));
});

test('a safety revision change after acceptance cancels the pending publication', async () => {
  const f = await fixture(), evaluation = await accepted(f);
  await bot.em.fork().transactional(async em => { await f.lifecycle.lockPrivacy(em, f.scope); const row = await em.findOneOrFail(GuildSafetyState, f.scope);
    row.resume(row.safetyRevision, { kind: 'system', operation: 'configuration_changed' }, new Date()); });
  const p = publisher(f); await p.service.dispatch(evaluation.id, new AbortController().signal);
  assert.equal(p.sends(), 0); assert.equal((await bot.em.fork().findOneOrFail(DebateEvaluation, f.scope)).publicationState, 'canceled');
});

test('expired settled metadata is deleted together after the accounting lifetime ends', async () => {
  const f = await fixture(); await accepted(f); await f.service.cancelSession(f.caller(), { sessionId: f.session.sessionId });
  await bot.em.fork().transactional(em => f.service.runRetention(em, new Date(Date.now() + 31 * 86400000)));
  for (const entity of [DebateSession, DebateEvaluation, ParticipantConsent, TranscriptEntry, TranscriptSnapshot, RubricRevision,
    AiTask, PreparedInput, TaskAcceptance, UsageReservation, UsageEntry]) assert.equal(await bot.em.fork().count<ScopedEntity>(entity, f.scope), 0);
});

test('expired proposal status suppresses topic and rubric before maintenance erases them', async () => {
  const f = await fixture();
  await bot.em.fork().execute('update debate_session set purge_after=clock_timestamp() where installation_id=? and id=?', [f.scope.installationId, f.session.sessionId]);
  const status = await f.service.readSession(f.caller(), { sessionId: f.session.sessionId });
  assert.equal(status.topic, null); assert.equal(status.rubric, null); assert.equal(status.sessionId, f.session.sessionId);
});

test('withdrawal during an already-started publication erases content and records its eventual outcome without retry', async () => {
  const f = await fixture(), evaluation = await accepted(f);
  let started!: () => void, finish!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; }), response = new Promise<void>(resolve => { finish = resolve; });
  const p = publisher(f, { /** Keep one actual send in flight while the independently committed withdrawal erases content. */
    send: async () => { started(); await response; } });
  const dispatch = p.service.dispatch(evaluation.id, new AbortController().signal); await sending;
  await f.service.recordConsent(f.caller(second), { sessionId: f.session.sessionId, scopeHash: f.session.scopeHash, accept: false });
  assert.equal((await bot.em.fork().findOneOrFail(DebateEvaluation, f.scope)).publicationState, 'unknown');
  finish(); await dispatch;
  const row = await bot.em.fork().findOneOrFail(DebateEvaluation, f.scope); assert.equal(row.publicationState, 'published'); assert.equal(row.criterionScores, null);
  await p.service.dispatch(evaluation.id, new AbortController().signal); assert.equal(p.sends(), 1);
});

test('lifecycle audit replays are bounded references and withdrawal records cannot duplicate or copy private content', async () => {
  const f = await fixture(), caller = f.caller(), input = { sessionId: f.session.sessionId, scopeHash: f.session.scopeHash, accept: true };
  await f.service.recordConsent(caller, input); await f.service.recordConsent(caller, input);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'debates.consent' }), 1);
  await f.service.recordConsent(f.caller(second), input); await f.service.startSession(f.caller(), { sessionId: f.session.sessionId });
  const submissionCaller = f.caller(), submission = { sessionId: f.session.sessionId, text: 'Private transcript must never be copied into audit.' };
  await f.service.appendEntry(submissionCaller, submission); await f.service.appendEntry(submissionCaller, submission);
  const withdrawal = { ...input, accept: false };
  await f.service.recordConsent(caller, withdrawal); await f.service.recordConsent(caller, withdrawal);
  const rows = await bot.em.fork().find(AuditEntry, f.scope);
  for (const operation of ['debates.proposal', 'debates.started', 'debates.submission', 'debates.consent_withdrawn', 'debates.canceled', 'debates.purged.participant_withdrawal'])
    assert.equal(rows.filter(row => row.operation === operation).length, 1);
  assert.equal(rows.find(row => row.operation === 'debates.consent_withdrawn')!.origin.kind, 'user');
  const serialized = JSON.stringify(rows);
  for (const privateText of [f.proposal.topic, f.proposal.rubric.criteria[0]!.description, submission.text]) assert.equal(serialized.includes(privateText), false);
  assert(rows.every(row => row.references.length <= 3 && row.purgeAfter > row.occurredAt));
});

test('publication claim and audit roll back together before sending, then one retry records intent and confirmed outcome', async () => {
  const f = await fixture(), evaluation = await accepted(f); let failed = false;
  bot.em.getEventManager().registerSubscriber({ /** Interrupt the committed-intent transaction after SQL flush, before any transport send. */ afterFlush(args: FlushEventArgs) {
    if (!failed && args.uow.getChangeSets().some(change => change.entity instanceof DebateEvaluation && change.entity.id === evaluation.id
      && change.entity.publicationState === 'claimed')) { failed = true; throw new Error('debate publication rollback'); }
  } });
  const p = publisher(f), signal = new AbortController().signal;
  await assert.rejects(p.service.dispatch(evaluation.id, signal), /publication rollback/); assert.equal(p.sends(), 0);
  assert.equal((await bot.em.fork().findOneOrFail(DebateEvaluation, f.scope)).publicationState, 'pending');
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'debates.publication' }), 0);
  await p.service.dispatch(evaluation.id, signal); await p.service.dispatch(evaluation.id, signal); assert.equal(p.sends(), 1);
  const rows = await bot.em.fork().find(AuditEntry, { ...f.scope, operation: 'debates.publication' });
  assert.deepEqual(rows.map(row => row.outcome).sort(), ['intent', 'succeeded']);
});

test('unavailable publication preflight defers the pending intent and a later fresh observation can send once', async () => {
  const f = await fixture(), evaluation = await accepted(f);
  const unavailable = publisher(f, { /** A failed external permission read conveys no definitive denial. */ prepare: async () => { throw new Error('publication_facts_unavailable'); } });
  const signal = new AbortController().signal; await unavailable.service.dispatch(evaluation.id, signal);
  assert.equal(unavailable.sends(), 0); assert.equal((await bot.em.fork().findOneOrFail(DebateEvaluation, f.scope)).publicationState, 'pending');
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'debates.publication' }), 0);
  const available = publisher(f); await available.service.dispatch(evaluation.id, signal); assert.equal(available.sends(), 1);
});
