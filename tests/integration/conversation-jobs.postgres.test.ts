/** Prove restricted worker claims, immutable outcomes and exact budget accounting with real PostgreSQL locks. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { createEntitySchemaSql } from '../../src/platform/db/schema-constraints.js';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { GuildSafetyState } from '../../src/contexts/administration/entities/guild-safety-state.entity.js';
import { UsagePolicy } from '../../src/contexts/administration/entities/usage-policy.entity.js';
import { ConversationRequest } from '../../src/contexts/community/entities/conversation-request.entity.js';
import { IntakeEvent } from '../../src/platform/intake/entities/intake-event.entity.js';
import { createConversationUsagePolicy } from '../../src/platform/usage/conversation-usage.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { WorkerTaskStore, type WorkerClaim } from '../../src/platform/jobs/worker-task.store.js';
import type { ReplyGenerationResult } from '../../src/ai/contracts/generation.contracts.js';

let database: ReturnType<typeof temporaryPostgres>;
let orm: MikroORM;
let workerOrm: MikroORM;
let worker: WorkerTaskStore;
const tasks = new TaskService();
let serial = 0;

beforeAll(async () => {
  database = temporaryPostgres();
  orm = new MikroORM({ ...entityOrmConfig(), ...database.options, ensureDatabase: false, logger: () => {} });
  await orm.connect();
  database.applySchema(await createEntitySchemaSql(orm));
  database.applySchema(`create role yuna_worker login; create role yuna_bot login;
    revoke create on schema public from public; grant usage on schema public to yuna_worker,yuna_bot;`);
  database.applySchema(readFileSync(resolve('src/platform/db/migrations/conversation-worker.sql'), 'utf8'));
  database.applySchema(readFileSync(resolve('src/platform/db/migrations/004-operating-controls.sql'), 'utf8'));
  database.applySchema(readFileSync(resolve('src/platform/db/migrations/006-user-quotas.sql'), 'utf8'));
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [],
    discovery: { warnWhenNoEntities: false }, ensureDatabase: false, logger: () => {} });
  await workerOrm.connect();
  worker = new WorkerTaskStore(workerOrm);
}, 60_000);

afterAll(async () => {
  try { await workerOrm?.close(true); await orm?.close(true); } finally { database?.close(); }
}, 30_000);

/** Register complete owner/task graphs using the actual public service and entity transitions. */
async function fixture(count = 1, cap = 20, dailyBudget?: string) {
  serial++;
  const guildId = String(910000000000000000n + BigInt(serial));
  const model = `fixture-model-${serial}`;
  const now = new Date();
  const deadline = new Date(now.getTime() + 120_000);
  const purgeAfter = new Date(now.getTime() + 86_400_000);
  const installed = new GuildInstallation({ guildId, generation: 1, registeredAt: now, createdAt: now, featureAdmission: { community: 'enabled' } });
  const scope = { installationId: installed.id, guildId };
  const registrations: { taskId: string; eventId: string; requestId: string }[] = [];
  await orm.em.fork().transactional(async em => {
    em.persist(installed);
    em.persist(new GuildSafetyState({ ...scope, createdAt: now, changedAt: now, changedBy: { kind: 'system', operation: 'fixture' } }));
    em.persist(createConversationUsagePolicy(scope, now, model, cap, dailyBudget === undefined ? undefined : {
      dailyAttemptLimit: cap, dailyBudget: { amount: dailyBudget, currency: 'USD' },
      prices: [{ provider: 'deepseek', model, version: 'fixture-price-v1', currency: 'USD',
        inputPerMillion: '1', outputPerMillion: '1', maxInputTokens: 32768, maxOutputTokens: 512 }],
    }));
    for (let index = 0; index < count; index++) {
      const channelId = '920000000000000001';
      const messageId = String(920000000000001000n + BigInt(index));
      const event = new IntakeEvent({ ...scope, createdAt: now, eventKind: 'message_create', sourceEventKey: `message:${messageId}`,
        sourceKey: `${channelId}/${messageId}`, ingressSequence: BigInt(index), observedAt: now, authorKind: 'user',
        authorUserId: '920000000000000002', contentAccess: 'available', coverage: ['content'],
        snapshot: { schemaVersion: 1, fields: { content: 'Hello Yuna' } }, purgeAfter, metadataPurgeAfter: purgeAfter });
      event.markCurrent(1, 'present');
      const request = new ConversationRequest({ ...scope, createdAt: now, requestKey: messageId,
        source: { kind: 'message', channelId, messageId }, sourceVersion: 1, settingsRevision: 1,
        contextBindings: [], audienceBinding: { schemaVersion: 1, visibility: 'channel', channelId, requesterUserId: null, revision: 0 }, deadline, purgeAfter });
      em.persist([event, request]);
      const taskId = tasks.registerTask(em, { ...scope, requestId: request.id, input: { text: 'Hello Yuna', maxOutputTokens: 128 },
        sourceEventId: event.id, sourceRevision: 1, safetyRevision: 0, deadline, purgeAfter, model, now });
      request.expectTask(taskId, 'generating', request.rowRevision, now);
      registrations.push({ taskId, eventId: event.id, requestId: request.id });
    }
  });
  return { scope, model, registrations, now, purgeAfter };
}

/** Model identifiers may resolve aliases; result authority remains the stored task/attempt. */
function successfulReply(claim: WorkerClaim): ReplyGenerationResult {
  return { text: 'Hello from Yuna.', providerRequestId: `response-${claim.attemptId}`, model: `${claim.model}-resolved`,
    inputTokens: 10, outputTokens: 5, totalTokens: 15, truncated: false };
}

/** Claim and start the fixture provider attempt through the restricted worker interface. */
async function claimAndStart(model: string): Promise<WorkerClaim> {
  const claim = await worker.claimNext('fixture-worker', model);
  assert.ok(claim);
  assert.equal((await worker.releasePreparedInput(claim))?.text, 'Hello Yuna');
  assert.equal(await worker.recordProviderStart(claim), true);
  return claim;
}

test('worker login has function access but no input, business-table, mutation or internal-helper access', async () => {
  const rows = await workerOrm.em.fork().execute<{ current_user: string }[]>('select current_user');
  assert.equal(rows[0]?.current_user, 'yuna_worker');
  for (const sql of ['select * from public.prepared_input', 'select * from public.conversation_request',
    "update public.ai_task set state='READY'", "select public.yuna_conversation_gate('00000000-0000-4000-8000-000000000000')",
    'select public.yuna_conversation_recover(1)']) {
    await assert.rejects(workerOrm.em.fork().execute(sql), /permission denied/);
  }
  assert.equal(await worker.claimNext('fixture-worker', 'not-installed'), null);
});

test('concurrent claims create one attempt, one reservation and one immutable result', async () => {
  const f = await fixture();
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => worker.claimNext(`worker-${i}`, f.model)));
  const winners = claims.filter((claim): claim is WorkerClaim => claim !== null);
  assert.equal(winners.length, 1);
  const claim = winners[0]!;
  assert.equal((await worker.releasePreparedInput(claim))?.text, 'Hello Yuna');
  assert.equal(await worker.releasePreparedInput(claim), null);
  assert.equal(await worker.recordProviderStart(claim), true);
  assert.equal(await worker.recordProviderStart(claim), false);
  const payload = successfulReply(claim);
  assert.equal(await worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload }), 'stored');
  assert.equal(await worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload }), 'stale');
  const pending = await tasks.pendingResults(orm.em.fork(), f.scope);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.payload?.text, payload.text);
  const counts = await orm.em.fork().execute<{ attempts: string; reservations: string; results: string; usage: string }[]>(`
    select (select count(*) from task_attempt where task_id=?)::text attempts,
      (select count(*) from usage_reservation where task_id=?)::text reservations,
      (select count(*) from task_result where task_id=?)::text results,
      (select count(*) from usage_entry where attempt_id=?)::text usage`, [claim.taskId, claim.taskId, claim.taskId, claim.attemptId]);
  assert.deepEqual(counts[0], { attempts: '1', reservations: '1', results: '1', usage: '1' });
  await orm.em.fork().transactional(async em => {
    const request = await em.findOneOrFail(ConversationRequest, f.registrations[0]!.requestId);
    request.cancel('fixture_discard', request.rowRevision, new Date());
    await tasks.acknowledge(em, f.scope, pending[0]!, 'discarded', 'fixture_discard', new Date());
  });
  assert.deepEqual(await tasks.pendingResults(orm.em.fork(), f.scope), []);
});

test('daily cap is atomic across competing tasks and claims never refund it', async () => {
  const f = await fixture(3, 2);
  const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => worker.claimNext(`cap-worker-${i}`, f.model)));
  assert.equal(claims.filter(Boolean).length, 2);
  assert.equal(await worker.claimNext('another-worker', f.model), null);
  const count = await orm.em.fork().execute<{ count: string }[]>('select count(*)::text count from usage_reservation where guild_id=?', [f.scope.guildId]);
  assert.equal(count[0]?.count, '2');
});

test('null or mismatched claim authority cannot disclose input or begin dispatch', async () => {
  const f = await fixture();
  const claim = await worker.claimNext('authority-worker', f.model);
  assert.ok(claim);
  const rows = await workerOrm.em.fork().execute<{ payload: unknown; started: boolean }[]>(`
    select public.yuna_conversation_release(?,?,?,null) as payload,
      public.yuna_conversation_start(?,?,?,null) as started`,
  [claim.taskId, claim.attemptId, claim.generation, claim.taskId, claim.attemptId, claim.generation]);
  assert.equal(rows[0]?.payload, null);
  assert.equal(rows[0]?.started, false);
  assert.equal(await worker.releasePreparedInput({ ...claim, generation: claim.generation + 1 }), null);
  assert.equal(await worker.releasePreparedInput({ ...claim, executorId: 'other-worker' }), null);
  assert.equal((await worker.releasePreparedInput(claim))?.text, 'Hello Yuna');
});

test('invalidation after claim blocks input and recovers a canceled no-dispatch result', async () => {
  const f = await fixture();
  const claim = await worker.claimNext('invalidated-worker', f.model);
  assert.ok(claim);
  await orm.em.fork().transactional(em => tasks.invalidateSource(em, f.scope, f.registrations[0]!.eventId, new Date()));
  assert.equal(await worker.releasePreparedInput(claim), null);
  await tasks.recoverExpired(orm.em.fork(), 100);
  const rows = await orm.em.fork().execute<{ outcome: string; accounting_state: string; actual_cost: string }[]>(`
    select r.outcome,u.accounting_state,u.actual_cost from task_result r
    join usage_entry u on u.attempt_id=r.attempt_id where r.task_id=?`, [claim.taskId]);
  assert.equal(rows[0]?.outcome, 'canceled');
  assert.equal(rows[0]?.accounting_state, 'no-spend');
  assert.equal(Number(rows[0]?.actual_cost), 0);
});

test('lost dispatched attempts remain uncertain and late usage cannot rewrite their result', async () => {
  const f = await fixture();
  const claim = await claimAndStart(f.model);
  await orm.em.fork().execute('update task_attempt set lease_until=clock_timestamp() where id=?', [claim.attemptId]);
  await tasks.recoverExpired(orm.em.fork(), 100);
  let pending = await tasks.pendingResults(orm.em.fork(), f.scope);
  assert.equal(pending[0]?.outcome, 'uncertain');
  assert.equal(await worker.recordResult(claim, { outcome: 'success', reason: 'late_response', payload: successfulReply(claim) }), 'stale');
  pending = await tasks.pendingResults(orm.em.fork(), f.scope);
  assert.equal(pending[0]?.outcome, 'uncertain');
  assert.equal(pending[0]?.payload, null);
  const usage = await orm.em.fork().execute<{ accounting_state: string; reported_units: { input_tokens: number }; actual_cost: string | null; state: string }[]>(`
    select u.accounting_state,u.reported_units,u.actual_cost,r.state from usage_entry u
    join usage_reservation r on r.id=u.reservation_id where u.attempt_id=?`, [claim.attemptId]);
  assert.equal(usage[0]?.accounting_state, 'estimated');
  assert.equal(usage[0]?.reported_units.input_tokens, 10);
  assert.equal(usage[0]?.actual_cost, null);
  assert.equal(usage[0]?.state, 'liability');
});

test('never-claimed expired tasks terminalize without inventing an execution attempt', async () => {
  const f = await fixture();
  const taskId = f.registrations[0]!.taskId;
  await orm.em.fork().execute('update ai_task set deadline=clock_timestamp() where id=?', [taskId]);
  await tasks.recoverExpired(orm.em.fork(), 100);
  const rows = await orm.em.fork().execute<{ outcome: string; attempt_id: string | null }[]>('select outcome,attempt_id from task_result where task_id=?', [taskId]);
  assert.equal(rows[0]?.outcome, 'expired');
  assert.equal(rows[0]?.attempt_id, null);
  assert.equal(await worker.claimNext('too-late', f.model), null);
});

test('retention erases input/result copies and leaves a durable owner-discard obligation', async () => {
  const f = await fixture();
  const claim = await claimAndStart(f.model);
  await worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload: successfulReply(claim) });
  await orm.em.fork().transactional(em => tasks.purgeExpired(em, f.scope, new Date(f.purgeAfter.getTime() + 1000)));
  const rows = await orm.em.fork().execute<{ input_payload: unknown; result_payload: unknown; pending_owner_discard: boolean }[]>(`
    select p.payload as input_payload,r.payload as result_payload,r.pending_owner_discard
    from prepared_input p join task_result r on r.task_id=p.task_id where p.task_id=?`, [claim.taskId]);
  assert.equal(rows[0]?.input_payload, null);
  assert.equal(rows[0]?.result_payload, null);
  assert.equal(rows[0]?.pending_owner_discard, true);
  assert.equal((await tasks.pendingResults(orm.em.fork(), f.scope)).length, 1);
});

test('monetary admission is atomic and measured settlement frees only the unused price estimate', async () => {
  const f = await fixture(3, 20, '0.04');
  const claims = await Promise.all(Array.from({ length: 5 }, (_, index) => worker.claimNext(`money-${index}`, f.model)));
  const winners = claims.filter((claim): claim is WorkerClaim => claim !== null);
  assert.equal(winners.length, 1, 'Two conservative reservations would exceed the daily cap');
  const claim = winners[0]!;
  await worker.releasePreparedInput(claim);
  await worker.recordProviderStart(claim);
  const payload = successfulReply(claim);
  await worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload });
  await worker.recordResult(claim, { outcome: 'success', reason: 'duplicate', payload });
  const rows = await orm.em.fork().execute<{ state: string; actual_cost: string; pricing_version: string }[]>(`
    select r.state,e.actual_cost,e.pricing_version from usage_reservation r join usage_entry e on e.reservation_id=r.id
    where r.attempt_id=?`, [claim.attemptId]);
  assert.equal(rows[0]?.state, 'settled');
  assert.equal(rows[0]?.actual_cost, '0.000015000000000000');
  assert.equal(rows[0]?.pricing_version, 'fixture-price-v1');
  assert.ok(await worker.claimNext('after-settlement', f.model));
  assert.equal(await worker.claimNext('still-bounded', f.model), null);
});

test('unknown spend retains its full priced reservation and late response settles the admitted price once', async () => {
  const f = await fixture(2, 20, '0.04');
  const claim = await claimAndStart(f.model);
  await worker.recordResult(claim, { outcome: 'uncertain', reason: 'timeout' });
  assert.equal(await worker.claimNext('unknown-is-not-free', f.model), null);
  await orm.em.fork().transactional(async em => {
    const policy = await em.findOneOrFail(UsagePolicy, f.scope);
    policy.revise({ schemaVersion: 1, limits: policy.limits, windowRules: policy.windowRules,
      perAttemptBounds: policy.perAttemptBounds.map(bound => ({ ...bound, pricingVersion: 'fixture-price-v2', inputPerMillion: '2',
        outputPerMillion: '2', maxCost: '0.06656' })) }, policy.policyRevision, { kind: 'system', operation: 'test-price-change' }, new Date());
  });
  assert.equal(await worker.recordResult(claim, { outcome: 'success', reason: 'late', payload: successfulReply(claim) }), 'stale');
  const usage = await orm.em.fork().execute<{ actual_cost: string; pricing_version: string }[]>(
    'select actual_cost,pricing_version from usage_entry where attempt_id=?', [claim.attemptId]);
  assert.equal(usage[0]?.actual_cost, '0.000015000000000000');
  assert.equal(usage[0]?.pricing_version, 'fixture-price-v1');
  const result = await orm.em.fork().execute<{ outcome: string }[]>('select outcome from task_result where task_id=?', [claim.taskId]);
  assert.equal(result[0]?.outcome, 'uncertain', 'Late billing evidence cannot replace the terminal result');
});

test('enabling a monetary cap refuses unpriced same-day liabilities instead of treating them as zero', async () => {
  const f = await fixture(2);
  const first = await claimAndStart(f.model);
  await worker.recordResult(first, { outcome: 'uncertain', reason: 'lost_response' });
  await orm.em.fork().transactional(async em => {
    const policy = await em.findOneOrFail(UsagePolicy, f.scope);
    const configured = createConversationUsagePolicy(f.scope, new Date(), f.model, 20, {
      dailyAttemptLimit: 20, dailyBudget: { amount: '10', currency: 'USD' },
      prices: [{ provider: 'deepseek', model: f.model, version: 'configured-v1', currency: 'USD',
        inputPerMillion: '1', outputPerMillion: '1', maxInputTokens: 32768, maxOutputTokens: 512 }],
    });
    policy.revise({ schemaVersion: 1, limits: configured.limits, windowRules: configured.windowRules,
      perAttemptBounds: configured.perAttemptBounds }, policy.policyRevision, { kind: 'system', operation: 'enable-budget' }, new Date());
  });
  assert.equal(await worker.claimNext('unpriced-liability-blocks', f.model), null);
});
