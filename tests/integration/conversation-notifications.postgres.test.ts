/** Verify transaction-scoped PostgreSQL notifications and runtime-role permissions without treating notifications as authority. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { ConversationRequest } from '../../src/contexts/community/entities/conversation-request.entity.js';
import { IntakeEvent } from '../../src/platform/intake/entities/intake-event.entity.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';

interface Notification { channel: string; payload?: string }
interface NotificationClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  on(event: 'notification', listener: (message: Notification) => void): unknown;
  off(event: 'notification', listener: (message: Notification) => void): unknown;
  release(destroy?: boolean): void;
}

let database: ReturnType<typeof temporaryPostgres>;
let botOrm: MikroORM;
let workerOrm: MikroORM;
let worker: WorkerTaskStore;
let listener: NotificationClient | undefined;
let serial = 0;
const tasks = new TaskService();
const notices: Notification[] = [];

beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres');
  url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'bot-notification-fixture', workerDatabasePassword: 'worker-notification-fixture' });
  botOrm = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false, logger: () => {} });
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [],
    discovery: { warnWhenNoEntities: false }, ensureDatabase: false, logger: () => {} });
  await botOrm.connect();
  await workerOrm.connect();
  worker = new WorkerTaskStore(workerOrm);
  const pool = await workerOrm.em.getConnection().getNativeClient();
  listener = await pool.connect() as NotificationClient;
  listener.on('notification', message => {
    if (message.channel !== 'yuna_notification_test_barrier') notices.push({ channel: message.channel, payload: message.payload });
  });
  await listener.query('listen yuna_tasks_ready; listen yuna_results_ready; listen yuna_notification_test_barrier');
}, 60_000);

afterAll(async () => {
  try {
    listener?.release(true);
    await workerOrm?.close(true);
    await botOrm?.close(true);
  } finally { database?.close(); }
}, 30_000);

/** Process a later notification on the listening session; no timing-based absence checks. */
function notificationCheckpoint(): Promise<void> {
  const connection = listener!;
  const marker = randomUUID();
  return new Promise((resolve, reject) => {
    /** Remove the notification listener and timer after the checkpoint finishes. */
    const cleanup = () => { clearTimeout(timer); connection.off('notification', receive); };
    /** Resolve the checkpoint only after its exact notification marker arrives. */
    const receive = (message: Notification) => {
      if (message.channel === 'yuna_notification_test_barrier' && message.payload === marker) { cleanup(); resolve(); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Notification checkpoint timed out')); }, 5_000);
    connection.on('notification', receive);
    void connection.query("select pg_catalog.pg_notify('yuna_notification_test_barrier', $1)", [marker])
      .catch(error => { cleanup(); reject(error); });
  });
}

/** Persist a valid owner/task graph, with a hook after SQL insertion but before commit. */
async function fixture(beforeCommit?: () => Promise<void>) {
  const model = `notification-model-${++serial}`;
  const guildId = String(950000000000000000n + BigInt(serial));
  const scope = await new GuildLifecycleService(botOrm).registerGuild(guildId, model);
  const now = new Date(), deadline = new Date(now.getTime() + 120_000), purgeAfter = new Date(now.getTime() + 86_400_000);
  const channelId = '960000000000000001', messageId = String(960000000000001000n + BigInt(serial));
  await botOrm.em.fork().transactional(async em => {
    const event = new IntakeEvent({ ...scope, createdAt: now, eventKind: 'message_create', sourceEventKey: `message:${messageId}`,
      sourceKey: `${channelId}/${messageId}`, ingressSequence: 1n, observedAt: now, authorKind: 'user',
      authorUserId: '960000000000000002', contentAccess: 'available', coverage: ['content'],
      snapshot: { schemaVersion: 1, fields: { content: 'Private notification input' } }, purgeAfter, metadataPurgeAfter: purgeAfter });
    event.markCurrent(1, 'present');
    const request = new ConversationRequest({ ...scope, createdAt: now, requestKey: messageId,
      source: { kind: 'message', channelId, messageId }, sourceVersion: 1, settingsRevision: 1,
      contextBindings: [], audienceBinding: { schemaVersion: 1, visibility: 'channel', channelId, requesterUserId: null, revision: 0 }, deadline, purgeAfter });
    em.persist([event, request]);
    const taskId = tasks.registerTask(em, { ...scope, requestId: request.id,
      input: { text: 'Private notification input', maxOutputTokens: 128 }, sourceEventId: event.id, sourceRevision: 1,
      safetyRevision: 0, deadline, purgeAfter, model, now });
    request.expectTask(taskId, 'generating', request.rowRevision, now);
    await em.flush();
    await beforeCommit?.();
  });
  return { scope, model };
}

test('task insertion notifies only after commit, never on rollback, with an empty payload', async () => {
  notices.length = 0;
  await fixture(async () => {
    await notificationCheckpoint();
    assert.deepEqual(notices, [], 'An uncommitted task must not wake listeners');
  });
  await notificationCheckpoint();
  assert.deepEqual(notices, [{ channel: 'yuna_tasks_ready', payload: '' }]);
  notices.length = 0;
  const rollback = new Error('Deliberate task rollback');
  await assert.rejects(fixture(async () => {
    await notificationCheckpoint();
    assert.deepEqual(notices, []);
    throw rollback;
  }), error => error === rollback);
  await notificationCheckpoint();
  assert.deepEqual(notices, [], 'Rolled-back tasks must not notify');
});

test('restricted worker result commits notify without data or additional grants; rollback and duplicate results do not', async () => {
  const f = await fixture();
  await notificationCheckpoint();
  notices.length = 0;
  const claim = await worker.claimNext('notification-worker', f.model);
  assert.ok(claim);
  assert.equal((await worker.releasePreparedInput(claim))?.text, 'Private notification input');
  assert.equal(await worker.recordProviderStart(claim), true);
  const outcome = { outcome: 'success' as const, reason: 'completed', payload: {
    text: 'Private notification reply', model: f.model, providerRequestId: 'private-provider-reference',
    inputTokens: 10, outputTokens: 5, totalTokens: 15, truncated: false,
  } };
  const rollback = new Error('Deliberate result rollback');
  await assert.rejects(workerOrm.em.fork().transactional(async em => {
    const rows = await em.execute<{ stored: boolean }[]>(
      'select public.yuna_conversation_finish(?,?,?,?,?::jsonb) as stored',
      [claim.taskId, claim.attemptId, claim.generation, claim.executorId, JSON.stringify(outcome)]);
    assert.equal(rows[0]?.stored, true);
    await notificationCheckpoint();
    assert.deepEqual(notices, [], 'The worker function must not notify before commit');
    throw rollback;
  }), error => error === rollback);
  await notificationCheckpoint();
  assert.deepEqual(notices, []);
  assert.deepEqual(await tasks.pendingResults(botOrm.em.fork(), f.scope), []);
  assert.equal(await worker.recordResult(claim, outcome), 'stored');
  await notificationCheckpoint();
  assert.deepEqual(notices, [{ channel: 'yuna_results_ready', payload: '' }]);
  assert.equal((await tasks.pendingResults(botOrm.em.fork(), f.scope)).length, 1);
  notices.length = 0;
  assert.equal(await worker.recordResult(claim, outcome), 'stale');
  await notificationCheckpoint();
  assert.deepEqual(notices, []);
});
