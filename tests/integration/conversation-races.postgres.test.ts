/** Prove conversation acceptance, invalidation and dispatch races against actual restricted PostgreSQL roles. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { GuildLifecycleService, type InstallationScope } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { LlmService } from '../../src/ai/llm/llm.service.js';
import type { DiscordGateway } from '../../src/discord/discord.module.js';
import type { DiscordReplyRequest, DiscordSendResult, NormalizedConversationMessage } from '../../src/discord/contracts.js';

let database: ReturnType<typeof temporaryPostgres>;
let botOrm: MikroORM;
let workerOrm: MikroORM;
let inspector: MikroORM;
let worker: WorkerTaskStore;
let serial = 0;
const tasks = new TaskService();
const fakeLlm = new LlmService({ mode: 'fake' }, 1000);
const signal = new AbortController().signal;

beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres');
  url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'bot-race-password', workerDatabasePassword: 'worker-race-password' });
  botOrm = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false, logger: () => {} });
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false, logger: () => {} });
  inspector = new MikroORM({ ...database.options, entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false, logger: () => {} });
  await Promise.all([botOrm.connect(), workerOrm.connect(), inspector.connect()]);
  worker = new WorkerTaskStore(workerOrm);
}, 60_000);

afterAll(async () => {
  try { await Promise.all([workerOrm?.close(true), botOrm?.close(true), inspector?.close(true)]); }
  finally { database?.close(); }
}, 30_000);

/** A promise gate controls ordering; timers below only bound failure, never decide who wins. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

type Checkpoint<T = void> = { entered: ReturnType<typeof deferred<T>>; release: ReturnType<typeof deferred<void>> };

/** Bound a broken fixture so its finally block can release held locks and drain operations. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Conversation race checkpoint did not complete')), 4000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Pause one real admission transaction after production code has acquired its installation/safety locks. */
class GatedAdministration extends GuildLifecycleService {
  private nextGate: Checkpoint<number> | null = null;

  /** Arm exactly one call; later contenders use the original admission implementation unchanged. */
  holdNextAdmission(): Checkpoint<number> {
    assert.equal(this.nextGate, null);
    const gate = { entered: deferred<number>(), release: deferred<void>() };
    this.nextGate = gate;
    return gate;
  }

  /** Retain the actual database locks while the test starts and observes a blocked competitor. */
  override async lockAdmission(em: EntityManager, scope: InstallationScope) {
    const gate = this.nextGate;
    this.nextGate = null;
    const admission = await super.lockAdmission(em, scope);
    if (gate) {
      const rows = await em.execute<{ pid: number }[]>('select pg_backend_pid() as pid');
      gate.entered.resolve(rows[0]!.pid);
      await bounded(gate.release.promise);
    }
    return admission;
  }
}

/** Observe PostgreSQL's lock graph, rather than guessing that a query has blocked after a delay. */
async function waitForBlockedBy(pid: number): Promise<void> {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const rows = await inspector.em.fork().execute<{ blocked: boolean }[]>(
      'select exists(select 1 from pg_stat_activity where ? = any(pg_blocking_pids(pid))) as blocked', [pid]);
    if (rows[0]?.blocked) return;
  }
  assert.fail('The competing operation never waited on the held admission lock');
}

/** Start two real operations in an observed lock order and always release/drain both on assertion failure. */
async function orderedRace<A, B>(administration: GatedAdministration, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  const gate = administration.holdNextAdmission();
  const firstRun = first();
  let secondRun: Promise<B> | undefined;
  try {
    const pid = await bounded(Promise.race([gate.entered.promise, firstRun.then(() => { throw new Error('First operation skipped its admission gate'); })]));
    secondRun = second();
    await bounded(Promise.race([waitForBlockedBy(pid), secondRun.then(() => { throw new Error('Competing operation bypassed its locked admission gate'); })]));
    gate.release.resolve();
    return await Promise.all([firstRun, secondRun]);
  } finally {
    gate.release.resolve();
    await Promise.allSettled([firstRun, secondRun]);
  }
}

/** Build a fresh guild with production services; only provider and Discord boundaries are deterministic fakes. */
async function scenario(selectedTasks: TaskService = tasks) {
  serial++;
  const model = `race-model-${serial}`;
  const guildId = String(970000000000000000n + BigInt(serial));
  const administration = new GatedAdministration(botOrm);
  const scope = await administration.registerGuild(guildId, model);
  const intake = new IntakeService();
  const conversation = new ConversationService(botOrm, scope, model, administration, intake, selectedTasks);
  const text = 'Yuna, verify a durable reply.';
  const message: NormalizedConversationMessage = { guildId, channelId: '971000000000000001', messageId: '971000000000000002',
    authorId: '971000000000000003', text, createdAt: new Date(), sourceHash: createHash('sha256').update(text).digest('hex') };
  const sent: DiscordReplyRequest[] = [];
  let readGate: Checkpoint | null = null;
  let sendGate: Checkpoint | null = null;
  let outcome: DiscordSendResult = { classification: 'delivered', messageId: '971000000000000004' };
  const transport: Pick<DiscordGateway, 'readSource' | 'sendReply' | 'findReply'> = {
    /** Pause before the local dispatch claim while leaving all database connections unlocked. */
    async readSource() {
      readGate?.entered.resolve();
      if (readGate) await bounded(readGate.release.promise);
      return { exists: true, canSend: true, sourceHash: message.sourceHash };
    },
    /** Record one external attempt, then allow source or availability changes while its outcome is pending. */
    async sendReply(request) {
      sent.push(request);
      sendGate?.entered.resolve();
      if (sendGate) await bounded(sendGate.release.promise);
      return outcome;
    },
    /** An empty reconciliation result cannot prove that an uncertain send did not happen. */
    async findReply() { return null; },
  };
  const delivery = new ReplyDeliveryService(botOrm, scope, administration, intake, transport, selectedTasks);
  assert.equal(await conversation.receiveInput(message), 'admitted');
  const claim = await worker.claimNext('race-worker', model);
  assert.ok(claim);
  const input = await worker.releasePreparedInput(claim);
  assert.ok(input);
  assert.equal(await worker.recordProviderStart(claim), true);
  const payload = await fakeLlm.generateReply(input);
  assert.equal(await worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload }), 'stored');
  return { scope, model, message, administration, conversation, delivery, sent,
    /** A fresh acceptor models a separate concurrent request without sharing ORM identity maps. */
    anotherAcceptor() { return new ConversationService(botOrm, scope, model, administration, intake, selectedTasks); },
    /** Arm the external source-read checkpoint for the next dispatch. */
    holdRead() { readGate = { entered: deferred<void>(), release: deferred<void>() }; return readGate; },
    /** Arm the external send checkpoint with the exact eventual observable Discord outcome. */
    holdSend(value: DiscordSendResult) { outcome = value; sendGate = { entered: deferred<void>(), release: deferred<void>() }; return sendGate; },
  };
}

/** Read committed owner/result state independently of the service's transaction and ORM identity map. */
async function state(scope: InstallationScope) {
  const rows = await botOrm.em.fork().execute<{
    stage: string; accepted_result: string | null; expected_task: string | null; canceled: boolean;
    delivery_id: string | null; delivery_state: string | null; attempts: number | null;
    accepted_content: string | null; decision: string | null; acknowledged: boolean;
  }[]>(`select c.stage,c.accepted_result_reference as accepted_result,c.expected_task_id as expected_task,
      c.canceled_at is not null as canceled,d.id as delivery_id,d.state as delivery_state,d.attempt_count as attempts,
      d.accepted_content,a.decision,a.acknowledged_at is not null as acknowledged
    from conversation_request c join ai_task t on t.workflow_id=c.id join task_result r on r.task_id=t.id
    left join reply_delivery d on d.request_id=c.id left join task_acceptance a on a.result_id=r.id
    where c.installation_id=?`, [scope.installationId]);
  assert.equal(rows.length, 1, 'One request, intent and acknowledgment must remain visible');
  return rows[0]!;
}

test('parallel acceptors block on the installation gate and commit one reply intent and acknowledgment', async () => {
  const f = await scenario();
  const results = await orderedRace(f.administration, () => f.conversation.acceptReplyResults(), () => f.anotherAcceptor().acceptReplyResults());
  assert.deepEqual(results, [1, 0]);
  const stored = await state(f.scope);
  assert.equal(stored.stage, 'accepted');
  assert.equal(stored.delivery_state, 'READY');
  assert.equal(stored.decision, 'accepted');
  assert.equal(stored.acknowledged, true);
  await f.delivery.recoverDueDeliveries(signal);
  assert.equal(f.sent.length, 1);
});

test.each(['acceptance', 'invalidation'] as const)('%s winning the admission lock preserves cancellation and exact acceptance history', async winner => {
  const f = await scenario();
  /** Run owner result acceptance as one participant in the ordered lock race. */
  const accept = () => f.conversation.acceptReplyResults();
  /** Apply the fixture owner invalidation under its normal transaction and lock order. */
  const invalidate = () => f.conversation.cancelRequest(f.message);
  if (winner === 'acceptance') assert.deepEqual(await orderedRace(f.administration, accept, invalidate), [1, undefined]);
  else assert.deepEqual(await orderedRace(f.administration, invalidate, accept), [undefined, 0]);
  const stored = await state(f.scope);
  assert.equal(stored.stage, 'canceled');
  assert.equal(stored.canceled, true);
  assert.equal(stored.decision, winner === 'acceptance' ? 'accepted' : 'discarded');
  assert.equal(stored.delivery_state, winner === 'acceptance' ? 'CANCELED' : null);
  assert.equal(stored.acknowledged, true);
  await f.delivery.recoverDueDeliveries(signal);
  assert.equal(f.sent.length, 0);
});

test('failure after flushing request acceptance, reply content and acknowledgment rolls all three back', async () => {
  let flushed = false;
  const failure = new Error('Deliberate post-flush acceptance failure');
  class FailingAcceptance extends TaskService {
    /** Flush the real production mutations, verify their transactional presence, then fail before commit. */
    override async acknowledge(...args: Parameters<TaskService['acknowledge']>): Promise<void> {
      await super.acknowledge(...args);
      const [em, scope] = args;
      await em.flush();
      const rows = await em.execute<{ stage: string; content: string; decision: string; acknowledged: boolean }[]>(
        `select c.stage,d.accepted_content as content,a.decision,a.acknowledged_at is not null as acknowledged
         from conversation_request c join reply_delivery d on d.request_id=c.id
         join task_result r on r.id=c.accepted_result_reference join task_acceptance a on a.result_id=r.id
         where c.installation_id=?`, [scope.installationId]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.stage, 'accepted');
      assert.ok(rows[0]!.content.length > 0);
      assert.equal(rows[0]!.decision, 'accepted');
      assert.equal(rows[0]!.acknowledged, true);
      flushed = true;
      throw failure;
    }
  }
  const f = await scenario(new FailingAcceptance());
  await assert.rejects(f.conversation.acceptReplyResults(), error => error === failure);
  assert.equal(flushed, true);
  const stored = await state(f.scope);
  assert.equal(stored.stage, 'generating');
  assert.ok(stored.expected_task);
  assert.equal(stored.accepted_result, null);
  assert.equal(stored.delivery_id, null);
  assert.equal(stored.decision, null);
  assert.equal(stored.acknowledged, false);
  await f.delivery.recoverDueDeliveries(signal);
  assert.equal(f.sent.length, 0);
  const recovered = new ConversationService(botOrm, f.scope, f.model, f.administration, new IntakeService(), tasks);
  assert.equal(await recovered.acceptReplyResults(), 1);
  await f.delivery.recoverDueDeliveries(signal);
  assert.equal(f.sent.length, 1);
});

test('cancellation owning the admission lock blocks a competing dispatch claim and prevents its send', async () => {
  const f = await scenario();
  assert.equal(await f.conversation.acceptReplyResults(), 1);
  const id = (await state(f.scope)).delivery_id!;
  await orderedRace(f.administration, () => f.conversation.cancelRequest(f.message), () => f.delivery.dispatch(id, signal));
  assert.equal((await state(f.scope)).delivery_state, 'CANCELED');
  assert.equal(f.sent.length, 0);
});

test('availability loss during a remote source read is rechecked at the later local dispatch claim', async () => {
  const f = await scenario();
  assert.equal(await f.conversation.acceptReplyResults(), 1);
  const gate = f.holdRead();
  const pending = f.delivery.dispatch((await state(f.scope)).delivery_id!, signal);
  try {
    await bounded(gate.entered.promise);
    await f.administration.recordAvailability(f.scope, false);
    gate.release.resolve();
    await pending;
  } finally { gate.release.resolve(); await pending; }
  assert.equal((await state(f.scope)).delivery_state, 'CANCELED');
  assert.equal(f.sent.length, 0);
});

test.each([
  ['cancellation', 'delivered'], ['cancellation', 'unknown'],
  ['availability', 'delivered'], ['availability', 'unknown'],
] as const)('%s during an already-started send preserves its %s outcome without another attempt', async (change, classification) => {
  const f = await scenario();
  assert.equal(await f.conversation.acceptReplyResults(), 1);
  const id = (await state(f.scope)).delivery_id!;
  const gate = f.holdSend(classification === 'delivered'
    ? { classification, messageId: '971000000000000004' } : { classification, code: 'fixture_connection_loss' });
  const pending = f.delivery.dispatch(id, signal);
  try {
    await bounded(gate.entered.promise);
    assert.equal((await state(f.scope)).delivery_state, 'DISPATCHED');
    // These database operations must finish while the remote call remains blocked: no I/O-held transaction.
    if (change === 'cancellation') await bounded(f.conversation.cancelRequest(f.message));
    else { await bounded(f.administration.recordAvailability(f.scope, false)); await bounded(f.conversation.cancelPending()); }
    await f.delivery.reconcile(id, signal);
    await f.delivery.dispatch(id, signal);
    assert.equal(f.sent.length, 1);
    assert.equal((await state(f.scope)).delivery_state, 'DISPATCHED');
    gate.release.resolve();
    await pending;
  } finally { gate.release.resolve(); await pending; }
  const stored = await state(f.scope);
  assert.equal(stored.stage, change === 'cancellation' ? 'canceled' : 'accepted');
  assert.equal(stored.canceled, change === 'cancellation');
  assert.equal(stored.delivery_state, classification === 'delivered' ? 'DELIVERED' : 'UNKNOWN');
  assert.equal(stored.attempts, 1);
  await f.delivery.recoverDueDeliveries(signal);
  await f.delivery.recoverDueDeliveries(signal);
  assert.equal(f.sent.length, 1);
  assert.equal((await state(f.scope)).delivery_state, stored.delivery_state);
});
