/** Exercise conversation intake, worker execution, accepted replies and uncertain delivery using real PostgreSQL and fake external adapters. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, jest, test } from '@jest/globals';
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
import { LlmService } from '../../src/ai/llm/llm.service.js';
import type { DiscordGateway } from '../../src/discord/discord.module.js';
import type { DiscordReplyRequest, NormalizedConversationMessage } from '../../src/discord/contracts.js';
import { chatContext } from '../helpers/chat-context.js';

let database: ReturnType<typeof temporaryPostgres>;
let botOrm: MikroORM;
let workerOrm: MikroORM;
let worker: WorkerTaskStore;
const tasks = new TaskService();
const fakeLlm = new LlmService({ mode: 'fake' }, 1000);
let serial = 0;

beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres');
  url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'bot-fixture-password', workerDatabasePassword: 'worker-fixture-password' });
  botOrm = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false, logger: () => {} });
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false, logger: () => {} });
  await botOrm.connect();
  await workerOrm.connect();
  worker = new WorkerTaskStore(workerOrm);
}, 60_000);

afterAll(async () => {
  try { await workerOrm?.close(true); await botOrm?.close(true); } finally { database?.close(); }
}, 30_000);

/** Real services and restricted database roles; only the external provider/Discord are fake. */
async function scenario(unknownSend = false) {
  serial++;
  const model = `flow-model-${serial}`;
  const guildId = String(930000000000000000n + BigInt(serial));
  const administration = new GuildLifecycleService(botOrm);
  const scope = await administration.registerGuild(guildId, model);
  const intake = new IntakeService();
  const conversation = new ConversationService(botOrm, scope, model, administration, intake, tasks);
  const text = 'Yuna, say hello.';
  const message: NormalizedConversationMessage = { guildId, channelId: '940000000000000001', messageId: '940000000000000002',
    authorId: '940000000000000003', text, createdAt: new Date(), sourceHash: createHash('sha256').update(text).digest('hex') };
  const sent: DiscordReplyRequest[] = [];
  let reconciledMessageId: string | null = null;
  const transport: Pick<DiscordGateway, 'readSource' | 'sendReply' | 'findReply'> = {
    /** Return the simulated current Discord source and permission state. */
    async readSource() { return { exists: true, canSend: true, sourceHash: message.sourceHash }; },
    /** Capture one simulated send and return this scenario's chosen transport outcome. */
    async sendReply(request) {
      sent.push(request);
      return unknownSend ? { classification: 'unknown', code: 'simulated_connection_loss' }
        : { classification: 'delivered', messageId: '940000000000000004' };
    },
    /** Return only the remotely attributed fixture reply during reconciliation. */
    async findReply() { return reconciledMessageId; },
  };
  const delivery = new ReplyDeliveryService(botOrm, scope, administration, intake, transport);
  return { scope, model, message, conversation, delivery, administration, sent,
    /** Expose a previously uncertain fixture send as confirmed remote state. */
    confirmRemoteDelivery() { reconciledMessageId = '940000000000000004'; } };
}

/** Execute the actual claim/release/dispatch/result boundary with the explicit fake capability. */
async function finishNext(model: string): Promise<void> {
  const claim = await worker.claimNext('flow-worker', model);
  assert.ok(claim, 'A durable compatible task must exist');
  const input = await worker.releasePreparedInput(claim);
  assert.ok(input);
  assert.equal(await worker.recordProviderStart(claim), true);
  const payload = await fakeLlm.generateReply(input);
  assert.equal(await worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload }), 'stored');
}

/** Read the stored fixture delivery state for the test assertion. */
async function deliveryState(installationId: string): Promise<string | undefined> {
  const rows = await botOrm.em.fork().execute<{ state: string }[]>('select state from reply_delivery where installation_id=?', [installationId]);
  return rows[0]?.state;
}

test('durable fake generation is accepted once and produces one Discord reply', async () => {
  const f = await scenario();
  assert.equal(await f.conversation.receiveInput(f.message), 'admitted');
  await finishNext(f.model);
  // Completion comes from PostgreSQL and survives replacing the service instance.
  const administration = new GuildLifecycleService(botOrm);
  const restarted = new ConversationService(botOrm, f.scope, f.model, administration, new IntakeService(), tasks);
  assert.equal(await restarted.acceptReplyResults(), 1);
  assert.equal(await restarted.acceptReplyResults(), 0);
  assert.equal(await worker.claimNext('another-worker', f.model), null);
  await f.delivery.recoverDueDeliveries(new AbortController().signal);
  await f.delivery.recoverDueDeliveries(new AbortController().signal);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.content, /Yuna \(fake mode\)/);
  assert.equal(f.sent[0]!.guildId, f.scope.guildId);
  assert.equal(f.sent[0]!.messageId, f.message.messageId);
  assert.equal(await deliveryState(f.scope.installationId), 'DELIVERED');
  const receipts = await botOrm.em.fork().execute<{ owner: string; state: string; outcome: string }[]>(
    'select owner,state,outcome from intake_delivery where installation_id=?', [f.scope.installationId]);
  assert.deepEqual(receipts, [{ owner: 'community', state: 'DONE', outcome: 'handled' }]);
});

test('same-channel context survives durable worker disclosure and drives a normal reply', async () => {
  const f = await scenario(), context = chatContext(f.message);
  assert.equal(await f.conversation.receiveInput({ ...f.message, chatContext: context }), 'admitted');
  const claim = await worker.claimNext('context-worker', f.model); assert.ok(claim);
  const input = await worker.releasePreparedInput(claim); assert.ok(input);
  assert.deepEqual(input.chatContext, context);
  assert.equal(await worker.recordProviderStart(claim), true);
  assert.equal(await worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload: await fakeLlm.generateReply(input) }), 'stored');
  assert.equal(await f.conversation.acceptReplyResults(), 1);
  await f.delivery.dispatchReadyDeliveries(new AbortController().signal); assert.equal(f.sent.length, 1);
});

test.each(['before_claim', 'before_disclosure', 'before_start', 'before_send'] as const)(
  'editing a selected context message blocks future work %s', async phase => {
    const f = await scenario(), context = chatContext(f.message);
    assert.equal(await f.conversation.receiveInput({ ...f.message, chatContext: context }), 'admitted');
    const claim = phase === 'before_claim' ? null : await worker.claimNext('context-worker', f.model);
    const input = claim && ['before_start', 'before_send'].includes(phase) ? await worker.releasePreparedInput(claim) : null;
    if (phase === 'before_send') {
      assert.ok(claim && input); assert.equal(await worker.recordProviderStart(claim), true);
      await worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload: await fakeLlm.generateReply(input) });
      assert.equal(await f.conversation.acceptReplyResults(), 1);
    }
    await f.conversation.cancelRequest({ ...f.message, messageId: context.messages[0]!.id });
    if (phase === 'before_claim') assert.equal(await worker.claimNext('context-worker', f.model), null);
    if (phase === 'before_disclosure') { assert.ok(claim); assert.equal(await worker.releasePreparedInput(claim), null); }
    if (phase === 'before_start') { assert.ok(claim); assert.equal(await worker.recordProviderStart(claim), false); }
    if (phase === 'before_send') { await f.delivery.dispatchReadyDeliveries(new AbortController().signal); assert.equal(f.sent.length, 0); }
  });

test('a context tombstone precedes late admission and cross-channel snapshots are rejected', async () => {
  const f = await scenario(), context = chatContext(f.message);
  await f.conversation.cancelRequest({ ...f.message, messageId: context.messages[0]!.id });
  assert.equal(await f.conversation.receiveInput({ ...f.message, chatContext: context }), 'admitted');
  const claim = await worker.claimNext('context-worker', f.model); assert.ok(claim);
  assert.deepEqual((await worker.releasePreparedInput(claim))?.chatContext?.messages, []);
  const g = await scenario();
  await assert.rejects(g.conversation.receiveInput({ ...g.message, chatContext: { ...chatContext(g.message), channelId: '999' } }), /another source/);
});

test('the restricted worker independently rejects a stale context row even before owner cancellation runs', async () => {
  const f = await scenario(), context = chatContext(f.message);
  await f.conversation.receiveInput({ ...f.message, chatContext: context });
  const claim = await worker.claimNext('context-worker', f.model); assert.ok(claim);
  await botOrm.em.fork().execute("update intake_event set source_validity='unresolved' where installation_id=? and source_key=?",
    [f.scope.installationId, `context:${f.message.channelId}:${context.messages[0]!.id}`]);
  assert.equal(await worker.releasePreparedInput(claim), null);
});

test('concurrent duplicate Discord observations admit one request and one generation', async () => {
  const f = await scenario();
  const outcomes = await Promise.all([f.conversation.receiveInput(f.message), f.conversation.receiveInput(f.message)]);
  assert.deepEqual(outcomes.sort(), ['admitted', 'duplicate']);
  await finishNext(f.model);
  await f.conversation.acceptReplyResults();
  await f.delivery.recoverDueDeliveries(new AbortController().signal);
  assert.equal(await f.conversation.receiveInput(f.message), 'duplicate');
  assert.equal(f.sent.length, 1);
  const rows = await botOrm.em.fork().execute<{ requests: string; tasks: string }[]>(`
    select (select count(*) from conversation_request where installation_id=?)::text requests,
      (select count(*) from ai_task where installation_id=?)::text tasks`, [f.scope.installationId, f.scope.installationId]);
  assert.deepEqual(rows[0], { requests: '1', tasks: '1' });
});

test('editing a claimed source blocks disclosure and cancels its request without generating again', async () => {
  const f = await scenario();
  await f.conversation.receiveInput(f.message);
  const claim = await worker.claimNext('edit-worker', f.model);
  assert.ok(claim);
  await f.conversation.cancelRequest(f.message);
  assert.equal(await worker.releasePreparedInput(claim), null);
  await tasks.recoverExpired(botOrm.em.fork(), 100);
  assert.equal(await f.conversation.acceptReplyResults(), 0);
  await f.delivery.recoverDueDeliveries(new AbortController().signal);
  assert.equal(f.sent.length, 0);
  assert.equal(await worker.claimNext('after-edit', f.model), null);
  const rows = await botOrm.em.fork().execute<{ stage: string; outcome: string; decision: string }[]>(`
    select c.stage,r.outcome,a.decision from conversation_request c join ai_task t on t.workflow_id=c.id
      join task_result r on r.task_id=t.id join task_acceptance a on a.result_id=r.id where c.installation_id=?`, [f.scope.installationId]);
  assert.deepEqual(rows[0], { stage: 'canceled', outcome: 'canceled', decision: 'discarded' });
});

test('an edit after acceptance cancels the unsent delivery', async () => {
  const f = await scenario();
  await f.conversation.receiveInput(f.message);
  await finishNext(f.model);
  assert.equal(await f.conversation.acceptReplyResults(), 1);
  await f.conversation.cancelRequest(f.message);
  await f.delivery.recoverDueDeliveries(new AbortController().signal);
  assert.equal(f.sent.length, 0);
  assert.equal(await deliveryState(f.scope.installationId), 'CANCELED');
});

test('disconnect/reconnect and bot restart fence old claims before any input disclosure', async () => {
  for (const gap of ['disconnect', 'restart'] as const) {
    const f = await scenario();
    await f.conversation.receiveInput(f.message);
    const claim = await worker.claimNext(`gap-worker-${gap}`, f.model);
    assert.ok(claim);
    if (gap === 'disconnect') {
      await f.administration.recordAvailability(f.scope, false);
      assert.equal(await worker.releasePreparedInput(claim), null);
      await f.conversation.cancelPending();
      await f.administration.recordAvailability(f.scope, true);
    } else {
      const resumed = await f.administration.registerGuild(f.scope.guildId, f.model);
      assert.equal(resumed.installationId, f.scope.installationId);
    }
    assert.equal(await worker.releasePreparedInput(claim), null);
    await tasks.recoverExpired(botOrm.em.fork(), 100);
    assert.equal(await f.conversation.acceptReplyResults(), 0);
    await f.delivery.recoverDueDeliveries(new AbortController().signal);
    assert.equal(f.sent.length, 0);
  }
});

test('a restart fences an already accepted READY reply before pending cancellation runs', async () => {
  const f = await scenario();
  await f.conversation.receiveInput(f.message);
  await finishNext(f.model);
  assert.equal(await f.conversation.acceptReplyResults(), 1);
  assert.equal(await deliveryState(f.scope.installationId), 'READY');
  await f.administration.registerGuild(f.scope.guildId, f.model);
  await f.delivery.recoverDueDeliveries(new AbortController().signal);
  assert.equal(f.sent.length, 0);
  assert.equal(await deliveryState(f.scope.installationId), 'CANCELED');
});

test('unknown Discord outcomes are reconciled using positive evidence and never resent', async () => {
  const f = await scenario(true);
  await f.conversation.receiveInput(f.message);
  await finishNext(f.model);
  await f.conversation.acceptReplyResults();
  await f.delivery.recoverDueDeliveries(new AbortController().signal);
  assert.equal(await deliveryState(f.scope.installationId), 'UNKNOWN');
  const rows = await botOrm.em.fork().execute<{ id: string }[]>('select id from reply_delivery where installation_id=?', [f.scope.installationId]);
  await f.delivery.reconcile(rows[0]!.id, new AbortController().signal);
  await f.delivery.reconcile(rows[0]!.id, new AbortController().signal);
  assert.equal(f.sent.length, 1);
  assert.equal(await deliveryState(f.scope.installationId), 'UNKNOWN');
  f.confirmRemoteDelivery();
  await f.delivery.reconcile(rows[0]!.id, new AbortController().signal);
  assert.equal(await deliveryState(f.scope.installationId), 'DELIVERED');
  assert.equal(f.sent.length, 1);
});

test('elapsed deadlines prevent sending and retention erases every conversation payload copy', async () => {
  const f = await scenario();
  await f.conversation.receiveInput(f.message);
  await finishNext(f.model);
  await f.conversation.acceptReplyResults();
  // Only Date advances; network/pool timers keep their real behavior during asynchronous cleanup.
  jest.useFakeTimers({ now: Date.now() + 25 * 60 * 60 * 1000,
    doNotFake: ['nextTick', 'queueMicrotask', 'hrtime', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] });
  try {
    await f.delivery.recoverDueDeliveries(new AbortController().signal);
    assert.equal(f.sent.length, 0);
    assert.equal(await deliveryState(f.scope.installationId), 'EXPIRED');
    await f.conversation.runRetention();
  } finally { jest.useRealTimers(); }
  const rows = await botOrm.em.fork().execute<{ snapshot: unknown; input: unknown; result: unknown; content: unknown; context: unknown; pending_owner_discard: boolean }[]>(`
    select e.snapshot,p.payload as input,r.payload as result,d.accepted_content as content,c.context_bindings as context,r.pending_owner_discard
    from conversation_request c join ai_task t on t.workflow_id=c.id join prepared_input p on p.task_id=t.id
      join intake_event e on e.id=p.source_event_id join task_result r on r.task_id=t.id
      join reply_delivery d on d.request_id=c.id where c.installation_id=?`, [f.scope.installationId]);
  assert.deepEqual(rows[0], { snapshot: null, input: null, result: null, content: null, context: null, pending_owner_discard: false });
});

test('delivery revalidates persisted audience, destination and mentions before claiming an external send', async () => {
  for (const [column, value] of [
    ['audience_binding', JSON.stringify({ schemaVersion: 1, visibility: 'channel', channelId: '940000000000000001', requesterUserId: '940000000000000009', revision: 1 })],
    ['reply_message_id', '940000000000000009'],
    ['allowed_mentions', JSON.stringify({ users: ['940000000000000009'], roles: [], everyone: false, repliedUser: false })],
  ] as const) {
    const f = await scenario();
    assert.equal(await f.conversation.receiveInput(f.message), 'admitted');
    await finishNext(f.model); assert.equal(await f.conversation.acceptReplyResults(), 1);
    // Deliberately inject a validly shaped but differently bound stored value, as from an incompatible writer.
    await botOrm.em.fork().execute(`update reply_delivery set ${column}=? where installation_id=?`, [value, f.scope.installationId]);
    await f.delivery.dispatchReadyDeliveries(new AbortController().signal);
    assert.equal(f.sent.length, 0); assert.equal(await deliveryState(f.scope.installationId), 'CANCELED');
  }
});
