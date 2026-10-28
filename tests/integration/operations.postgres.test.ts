/** Rehearse real backup/restore and bounded fake-provider load in isolated databases, without external effects. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { AiTaskHandlers } from '../../apps/ai-worker/task.handlers.js';
import { LlmService } from '../../src/ai/llm/llm.service.js';
import { createBotOwnership } from '../../src/platform/runtime/bot-ownership.js';
import { readHealthSnapshot } from '../../src/platform/runtime/health.js';
import type { LatencySample } from '../../src/platform/runtime/latency.js';
let database: ReturnType<typeof temporaryPostgres>;
let admin: MikroORM;
const connections: MikroORM[] = [];
/** Every role connects only to the test cluster's private Unix socket. */
function connect(dbName: string, user: string, entities = true) {
  const orm = new MikroORM({ ...(entities ? entityOrmConfig() : { entities: [], discovery: { warnWhenNoEntities: false } }),
    ...database.options, dbName, user, ensureDatabase: false, logger: () => {} });
  connections.push(orm); return orm;
}
/** Preparation remains explicit and uses no runtime credential for schema ownership. */
function settings(dbName: string) {
  const url = new URL(`postgresql://yuna_test@localhost:55432/${dbName}`); url.searchParams.set('host', database.options.host);
  return { adminDatabaseUrl: url.href, botDatabasePassword: 'fixture-bot', workerDatabasePassword: 'fixture-worker' };
}
beforeAll(async () => {
  database = temporaryPostgres(); admin = connect('postgres', 'yuna_test', false);
  await admin.em.fork().execute('create database operational_source');
  await prepareDatabase(settings('operational_source'));
}, 60_000);
afterAll(async () => { try { await Promise.all(connections.map(orm => orm.close(true))); } finally { database?.close(); } }, 30_000);

/** Real owner/task services prepare one guild; only the downstream provider/Discord effects are fake. */
async function fixture(dbName: string, guildId: string, samples: LatencySample[] = []) {
  const bot = connect(dbName, 'yuna_bot'), worker = connect(dbName, 'yuna_worker', false);
  const lifecycle = new GuildLifecycleService(bot), scope = await lifecycle.registerGuild(guildId, 'fake');
  const intake = new IntakeService(), tasks = new TaskService(), store = new WorkerTaskStore(worker);
  const conversation = new ConversationService(bot, scope, 'fake', lifecycle, intake, tasks, value => samples.push(value));
  /** Create a unique fake input for the bounded load rehearsal. */
  const input = (n: number) => ({ guildId, channelId: '970000000000000002', messageId: String(970000000000000010n + BigInt(n)),
    authorId: '970000000000000003', text: 'Bounded operational fixture.', sourceHash: 'a'.repeat(64), createdAt: new Date() });
  return { bot, worker, lifecycle, scope, intake, tasks, store, conversation, input };
}

test('pg_dump/pg_restore preserves migration history and never retries a previously disclosed attempt', async () => {
  const f = await fixture('operational_source', '970000000000000001');
  assert.equal(await f.conversation.receiveInput(f.input(0)), 'admitted');
  const claim = await f.store.claimNext('before-backup', 'fake'); assert.ok(claim);
  assert.ok(await f.store.releasePreparedInput(claim)); assert.ok(await f.store.recordProviderStart(claim));
  const directory = await mkdtemp(join(tmpdir(), 'yuna-backup-rehearsal-'));
  try {
    const path = join(directory, 'isolated.dump');
    const common = ['-h', database.options.host, '-p', String(database.options.port), '-U', 'yuna_test'];
    execFileSync('pg_dump', [...common, '-d', 'operational_source', '--format=custom', '--file', path], { stdio: 'pipe', timeout: 30_000 });
    await admin.em.fork().execute('create database operational_restored');
    execFileSync('pg_restore', [...common, '-d', 'operational_restored', '--single-transaction', '--no-owner', path], { stdio: 'pipe', timeout: 30_000 });
    const result = await prepareDatabase(settings('operational_restored'));
    assert.ok(result.migrations.every(row => row.status === 'already_applied'));
    const restored = await fixture('operational_restored', f.scope.guildId);
    assert.deepEqual(restored.scope, f.scope);
    assert.equal(await restored.tasks.recoverExpired(restored.bot.em.fork()), 1);
    assert.equal(await restored.store.claimNext('after-restore', 'fake'), null);
    const rows = await restored.bot.em.fork().execute<{ state: string; attempt_count: number; reservation: string }[]>(
      'select t.state,t.attempt_count,u.state as reservation from ai_task t join usage_reservation u on u.task_id=t.id where t.id=?', [claim.taskId]);
    assert.deepEqual(rows, [{ state: 'TERMINAL', attempt_count: 1, reservation: 'liability' }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test('thirty concurrent inputs keep the twenty-request bound and four worker lanes never duplicate replies', async () => {
  const samples: LatencySample[] = [], f = await fixture('operational_source', '970000000000000101', samples);
  const begun = performance.now();
  const admitted = await Promise.all(Array.from({ length: 30 }, (_, index) => f.conversation.receiveInput(f.input(index))));
  assert.equal(admitted.filter(value => value === 'admitted').length, 20);
  assert.equal(admitted.filter(value => value === 'busy').length, 10);
  const provider = new LlmService({ mode: 'fake' }, 1000), signal = AbortSignal.timeout(30_000);
  await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const handler = new AiTaskHandlers(f.store, provider, `lane-${index}`, 'fake', 1000, sample => samples.push(sample));
    while (await handler.runOne(signal)) { /* Drain only this finite, capped fixture batch. */ }
  }));
  assert.equal(await f.conversation.acceptReplyResults(), 20);
  const sent = new Set<string>();
  const delivery = new ReplyDeliveryService(f.bot, f.scope, f.lifecycle, f.intake, {
    /** Return the simulated current Discord source and permission state. */
    async readSource() { return { exists: true, canSend: true, sourceHash: 'a'.repeat(64) }; },
    /** Capture one simulated send and return this scenario's chosen transport outcome. */
    async sendReply(request) {
      assert.equal(sent.has(request.messageId), false); sent.add(request.messageId);
      return { classification: 'delivered', messageId: '970000000000009999' };
    }, /** Return only the remotely attributed fixture reply during reconciliation. */ async findReply() { return null; },
  }, f.tasks, sample => samples.push(sample));
  await delivery.dispatchReadyDeliveries(signal); await delivery.dispatchReadyDeliveries(signal);
  assert.equal(sent.size, 20);
  const rows = await f.bot.em.fork().execute<{ tasks: number; attempts: number; ready: number }[]>(`select
    (select count(*)::integer from ai_task where installation_id=?) as tasks,
    (select count(*)::integer from task_attempt where installation_id=?) as attempts,
    (select count(*)::integer from reply_delivery where installation_id=? and state='READY') as ready`,
  [f.scope.installationId, f.scope.installationId, f.scope.installationId]);
  assert.deepEqual(rows, [{ tasks: 20, attempts: 20, ready: 0 }]);
  const total = samples.filter(sample => sample.stage === 'end_to_end').map(sample => sample.durationMs).sort((a, b) => a - b);
  assert.equal(total.length, 20);
  console.info(JSON.stringify({ event: 'bounded_load_rehearsal', input: 30, admitted: 20, busy: 10, workers: 4,
    delivered: sent.size, durationMs: Math.round(performance.now() - begun), endToEndP95Ms: total[18] }));
}, 60_000);


test('health distinguishes a live ownership session from stale available state without taking the lock', async () => {
  const f = await fixture('operational_source', '970000000000000201'), signal = AbortSignal.timeout(5000);
  const ownership = createBotOwnership(() => f.bot, f.scope.guildId, () => {});
  assert.equal((await readHealthSnapshot(f.bot, f.scope.guildId, signal)).ready, false);
  try {
    await ownership.start(signal);
    const online = await readHealthSnapshot(f.bot, f.scope.guildId, signal);
    assert.equal(online.ready, true); assert.equal(online.botOwnsGuild, true);
    await f.lifecycle.recordAvailability(f.scope, false);
    assert.equal((await readHealthSnapshot(f.bot, f.scope.guildId, signal)).ready, false);
  } finally { await ownership.stop(); }
  assert.equal((await readHealthSnapshot(f.bot, f.scope.guildId, signal)).botOwnsGuild, false);
});
