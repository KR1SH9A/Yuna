/** Prove notifications drive the real durable flow with two workers and no fallback polling. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { createTaskWakeup } from '../../src/platform/jobs/task-wakeup.js';
import { runBackgroundLoop } from '../../src/platform/runtime/background-loop.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { AiTaskHandlers } from '../../apps/ai-worker/task.handlers.js';
import type { NormalizedConversationMessage } from '../../src/discord/contracts.js';
import type { LatencySample } from '../../src/platform/runtime/latency.js';

let database: ReturnType<typeof temporaryPostgres>;
let botOrm: MikroORM;
let workerOrm: MikroORM;

beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres');
  url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'fixture-bot', workerDatabasePassword: 'fixture-worker' });
  botOrm = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false, logger: () => {} });
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [],
    discovery: { warnWhenNoEntities: false }, ensureDatabase: false, logger: () => {} });
  await botOrm.connect();
  await workerOrm.connect();
}, 60_000);

afterAll(async () => {
  try { await workerOrm?.close(true); await botOrm?.close(true); } finally { database?.close(); }
}, 30_000);

/** A promise gate gives each race a deliberate ordering instead of arbitrary sleeps. */
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Fail a missing notification promptly; the consumer fallback is intentionally one minute. */
async function until(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error('Notification flow did not finish before the test deadline'));
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

test('committed jobs and results wake idle consumers; two lanes overlap without duplicate replies', async () => {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]);
  const tasksReady = createTaskWakeup(() => workerOrm, 'yuna_tasks_ready');
  const resultsReady = createTaskWakeup(() => botOrm, 'yuna_results_ready');
  const idle = gate();
  const botIdle = gate();
  const bothGenerating = gate();
  const releaseProvider = gate();
  const delivered = gate();
  const running: Promise<void>[] = [];
  const errors: string[] = [];
  const samples: LatencySample[] = [];
  /** Collect committed timing samples for assertions without logging source content. */
  const report = (sample: LatencySample) => { samples.push(sample); };
  const model = 'notification-flow-model';
  const administration = new GuildLifecycleService(botOrm);
  const scope = await administration.registerGuild('960000000000000001', model);
  const intake = new IntakeService();
  const tasks = new TaskService();
  const conversation = new ConversationService(botOrm, scope, model, administration, intake, tasks, report);
  const store = new WorkerTaskStore(workerOrm);
  let emptyScans = 0;
  const trackedStore = {
    /** Return the fixture claim and record that the worker attempted to acquire work. */
    async claimNext(executor: string, selectedModel: string) {
      const claim = await store.claimNext(executor, selectedModel);
      if (!claim && ++emptyScans === 2) idle.resolve();
      return claim;
    },
    releasePreparedInput: store.releasePreparedInput.bind(store),
    recordProviderStart: store.recordProviderStart.bind(store),
    recordResult: store.recordResult.bind(store),
  };
  const messages: NormalizedConversationMessage[] = [0, 1].map(index => ({
    guildId: scope.guildId, channelId: '960000000000000002', messageId: String(960000000000000010n + BigInt(index)),
    authorId: '960000000000000003', text: `Private fixture message ${index}`, createdAt: new Date(), sourceHash: 'a'.repeat(64),
  }));
  const sent: string[] = [];
  const delivery = new ReplyDeliveryService(botOrm, scope, administration, intake, {
    /** Return the simulated current Discord source and permission state. */
    async readSource() { return { exists: true, canSend: true, sourceHash: 'a'.repeat(64) }; },
    /** Capture one simulated send and return this scenario's chosen transport outcome. */
    async sendReply(request) { sent.push(request.messageId); return { classification: 'delivered', messageId: '960000000000000099' }; },
    /** Return only the remotely attributed fixture reply during reconciliation. */
    async findReply() { return null; },
  }, tasks, report);
  let providerCalls = 0;
  try {
    await tasksReady.start(signal);
    await resultsReady.start(signal);
    for (let lane = 0; lane < 2; lane++) {
      const handler = new AiTaskHandlers(trackedStore, {
        /** Return or delay a deterministic generation result without making a provider request. */
        async generateReply() {
          if (++providerCalls === 2) bothGenerating.resolve();
          await until(releaseProvider.promise, signal);
          return { text: 'Hello from the test.', model, providerRequestId: randomUUID(),
            inputTokens: 4, outputTokens: 3, totalTokens: 7, truncated: false };
        },
      }, `notification-lane-${lane}`, model, 7_000, report);
      running.push(runBackgroundLoop({ signal, wakeup: tasksReady, intervalMs: 60_000,
        run: () => handler.runOne(signal), onError: () => { errors.push('worker'); } }));
    }
    running.push(runBackgroundLoop({ signal, wakeup: resultsReady, intervalMs: 60_000,
      /** Execute one controlled loop iteration and expose its timing or failure to the test. */
      async run() {
        const accepted = await conversation.acceptReplyResults();
        await delivery.dispatchReadyDeliveries(signal);
        if (sent.length === 2) delivered.resolve();
        botIdle.resolve();
        return accepted > 0;
      }, onError: () => { errors.push('bot'); } }));
    await until(Promise.all([idle.promise, botIdle.promise]).then(() => {}), signal);
    for (const message of messages) assert.equal(await conversation.receiveInput(message), 'admitted');
    await until(bothGenerating.promise, signal);
    assert.equal(providerCalls, 2, 'Both providers must begin before either is released');
    releaseProvider.resolve();
    await until(delivered.promise, signal);
    assert.deepEqual(sent.sort(), messages.map(message => message.messageId).sort());
    assert.deepEqual(errors, []);
    assert.equal(samples.filter(sample => sample.stage === 'end_to_end').length, 2);
    assert.equal(samples.filter(sample => sample.stage === 'queue_wait').length, 2);
    const rows = await botOrm.em.fork().execute<{ attempts: number; results: number }[]>(`
      select (select count(*)::integer from task_attempt) as attempts,
        (select count(*)::integer from task_result) as results`);
    assert.deepEqual(rows[0], { attempts: 2, results: 2 });
  } finally {
    controller.abort();
    releaseProvider.resolve();
    await Promise.all(running);
    await resultsReady.stop();
    await tasksReady.stop();
  }
}, 12_000);
