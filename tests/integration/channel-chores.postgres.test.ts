/** Exercise real chore claims, source fences, crash recovery and removal in a disposable restricted PostgreSQL cluster. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeAll, afterAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { ChannelChoreService } from '../../src/contexts/administration/channel-chore.service.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { chatContext } from '../helpers/chat-context.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { AuditRecorder } from '../../src/platform/audit/audit.recorder.js';
import type { ChannelChoreOperation, ChannelChoreOutcome } from '../../src/discord/channel-chore.contracts.js';
import type { NormalizedConversationMessage } from '../../src/discord/contracts.js';

let database: ReturnType<typeof temporaryPostgres>, bot: MikroORM, worker: MikroORM, serial = 0;
const signal = new AbortController().signal;
beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'chore-bot', workerDatabasePassword: 'chore-worker' });
  bot = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false });
  worker = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false });
  await bot.connect(); await worker.connect();
}, 60_000);
afterAll(async () => { try { await bot?.close(true); await worker?.close(true); } finally { database?.close(); } }, 30_000);

/** Each scenario uses an independent installation and a fake external transport that observes real committed claims. */
async function fixture(audit?: AuditRecorder) {
  const lifecycle = new GuildLifecycleService(bot), intake = new IntakeService();
  const scope = await lifecycle.registerGuild(String(980000000000000000n + BigInt(++serial)), 'chore-test');
  let number = 0;
  const state = { planning: false, allowed: true, writes: 0, replies: [] as string[], reconcile: null as string | null,
    outcome: { state: 'CONFIRMED', channelId: '980000000000000900' } as ChannelChoreOutcome,
    beforeWrite: async () => {}, beforePrepare: async () => {} };
  const service = new ChannelChoreService(bot, scope, lifecycle, intake, {
    /** Give only the authenticated fixture administrator a real scoped directory. */
    async readPlanningChannels() { return state.planning && state.allowed ? { channels: [
      { id: '980000000000000900', name: 'vc created by yuna', type: 2 as const, parentId: null },
      { id: '980000000000000902', name: 'Voice Channels', type: 4 as const, parentId: null }], directoryPartial: false } : null; },
    /** Simulate native permission checks; the real adapter has separate role/source tests. */
    async prepare(_caller, request) { await state.beforePrepare(); return !state.allowed ? null : request.kind === 'create' ? request : request.kind === 'move'
      ? { kind: 'modify', channelId: request.channel, channelType: 2, field: 'parent_id', value: request.parentId, previous: null } : null; },
    /** Observe durable intent before the external attempt and honor the owner's last local gate. */
    async execute(_caller, _operation, id, _signal, mayWrite) {
      const rows = await bot.em.fork().execute<{ state: string }[]>('select state from channel_chore where id=?', [id]);
      assert.equal(rows[0]?.state, 'DISPATCHED');
      await state.beforeWrite();
      if (!await mayWrite()) return { state: 'FAILED', reason: 'local_gate_closed' };
      state.writes++; return state.outcome;
    },
    /** Only affirmative attributable evidence can resolve an unknown outcome. */
    async reconcile() { return state.reconcile; },
  }, { /** Record response content separately from the actual channel mutation. */
    async sendReply(request) { state.replies.push(request.content); return { classification: 'delivered', messageId: '980000000000000901' }; } }, audit);
  /** Build distinct authenticated input identities with explicit command text. */
  const message = (text = 'Yuna create a voice channel Gaming'): NormalizedConversationMessage => ({ ...scope,
    authorId: '980000000000000800', channelId: '980000000000000700', messageId: String(980000000000001000n + BigInt(++number)),
    text, sourceHash: createHash('sha256').update(text).digest('hex'), createdAt: new Date() });
  /** Read only this fixture installation, keeping assertions independent of other tests. */
  const rows = () => bot.em.fork().execute<{ id: string; state: string; operation: ChannelChoreOperation | null; reason: string }[]>(
    'select * from channel_chore where installation_id=? order by created_at,id', [scope.installationId]);
  return { state, service, scope, lifecycle, intake, message, rows };
}

test('successful chore commits once, emits a factual receipt and deduplicates concurrent source delivery', async () => {
  const f = await fixture(), message = f.message();
  assert.deepEqual(await Promise.all([f.service.receiveInput(message, signal), f.service.receiveInput(message, signal)]), [true, true]);
  assert.equal(f.state.writes, 1); assert.equal((await f.rows()).length, 1); assert.equal((await f.rows())[0]!.state, 'CONFIRMED');
  assert.deepEqual(f.state.replies, ['Created <#980000000000000900>.']);
  const audit = await bot.em.fork().execute<{ outcome: string }[]>('select outcome from audit_entry where installation_id=? order by occurred_at', [f.scope.installationId]);
  assert.deepEqual(audit.map(row => row.outcome), ['intent', 'succeeded']);
  await assert.rejects(worker.em.fork().execute('select * from channel_chore'));
});

test('a complete conversational follow-up is handled as a chore regardless of the previous chat explanation', async () => {
  for (const allowed of [true, false]) {
    const f = await fixture(); f.state.allowed = allowed;
    const message = { ...f.message('okay yuna, create a channel named "Minecraft by Yuna"'),
      previousReply: 'I cannot create channels from this reply. Use the separate authenticated handler.' };
    assert.equal(await f.service.receiveInput(message, signal), true, 'Do not fall through to model conversation');
    assert.equal(f.state.writes, allowed ? 1 : 0);
    assert.equal((await f.rows()).length, allowed ? 1 : 0);
    if (allowed) {
      assert.deepEqual((await f.rows())[0]!.operation, { kind: 'create', channelType: 0, name: 'Minecraft by Yuna' });
      assert.deepEqual(f.state.replies, ['Created <#980000000000000900>.']);
    } else assert.match(f.state.replies[0]!, /Only the server owner or a Discord Administrator/);
  }
});

test('unrecognized discussions stay in chat and denied requests cannot become authorized through replay', async () => {
  const f = await fixture();
  assert.equal(await f.service.receiveInput(f.message('Yuna explain how to make a channel'), signal), false);
  f.state.allowed = false; const message = f.message(); await f.service.receiveInput(message, signal);
  f.state.allowed = true; await f.service.receiveInput(message, signal);
  assert.equal(f.state.writes, 0); assert.equal((await f.rows()).length, 0); assert.equal(f.state.replies.length, 1);
});

test('source invalidation and safety revision changes after dispatch prevent external writes', async () => {
  for (const cause of ['source', 'safety'] as const) {
    const f = await fixture(), message = f.message();
    f.state.beforeWrite = async () => {
      if (cause === 'safety') await f.lifecycle.recordAvailability(f.scope, false);
      else await bot.em.fork().transactional(async em => { await f.lifecycle.lockPrivacy(em, f.scope); await f.intake.invalidate(em, f.scope, message, new Date()); });
    };
    await f.service.receiveInput(message, signal);
    assert.equal(f.state.writes, 0); assert.equal((await f.rows())[0]!.state, 'FAILED');
  }
});

test('unknown outcomes never retry and block an identical new request until exact reconciliation', async () => {
  const f = await fixture(); f.state.outcome = { state: 'UNKNOWN', reason: 'lost_response' };
  await f.service.receiveInput(f.message(), signal); await f.service.runMaintenance(signal);
  await f.service.receiveInput(f.message(), signal);
  assert.equal(f.state.writes, 1); assert.deepEqual((await f.rows()).map(row => row.state), ['UNKNOWN', 'CANCELED']);
  assert.ok(f.state.replies[0]!.includes('uncertain'));
  f.state.reconcile = '980000000000000900'; await f.service.runMaintenance(signal);
  assert.equal((await f.rows())[0]!.state, 'CONFIRMED'); assert.equal(f.state.writes, 1);
});

test('the single guild claim prevents overlapping identical requests and rate limits independent new actions', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { entered = resolve; });
  f.state.beforeWrite = async () => { entered(); await blocked; };
  const first = f.service.receiveInput(f.message(), signal); await observed;
  await f.service.receiveInput(f.message(), signal); release(); await first;
  assert.equal(f.state.writes, 1);
  f.state.beforeWrite = async () => {};
  for (let i = 0; i < 5; i++) await f.service.receiveInput(f.message(`Yuna create a vc game-${i}`), signal);
  assert.equal(f.state.writes, 5);
  assert.equal((await f.rows()).filter(row => row.state === 'CANCELED').length, 2);
});

test('expired dispatch is reconciled rather than retried; live dispatch is left alone', async () => {
  const f = await fixture(); await f.service.receiveInput(f.message(), signal);
  const id = (await f.rows())[0]!.id;
  await bot.em.fork().execute("update channel_chore set state='DISPATCHED',replied_at=null where id=?", [id]);
  await f.service.runMaintenance(signal); assert.equal((await f.rows())[0]!.state, 'DISPATCHED');
  await bot.em.fork().execute("update channel_chore set dispatched_at=now()-interval '1 minute' where id=?", [id]);
  await f.service.runMaintenance(signal); assert.equal((await f.rows())[0]!.state, 'UNKNOWN'); assert.equal(f.state.writes, 1);
});

test('removal erases retained operation payloads, fences in-flight writes and retains explicit outcome metadata', async () => {
  const f = await fixture();
  f.state.beforeWrite = async () => { await bot.em.fork().transactional(async em => {
    await f.lifecycle.lockPrivacy(em, f.scope);
    const result = await f.service.cleanup(em, new Date(), true); assert.equal(result.disposition, 'retained');
  }); };
  await f.service.receiveInput(f.message(), signal);
  assert.equal(f.state.writes, 0); assert.equal((await f.rows())[0]!.operation, null);
  await f.service.runMaintenance(signal); assert.equal(f.state.replies.length, 0);
});

test('a failed admission audit rolls back source, receipt and intent before any Discord mutation', async () => {
  class FailingAudit extends AuditRecorder {
    /** Inject a transaction failure after the durable audit insert to prove the entire admission rolls back. */
    override async recordTransition(...args: Parameters<AuditRecorder['recordTransition']>): Promise<string> {
      await super.recordTransition(...args); throw new Error('rollback-fixture');
    }
  }
  const f = await fixture(new FailingAudit());
  await assert.rejects(f.service.receiveInput(f.message(), signal), /rollback-fixture/);
  assert.equal(f.state.writes, 0); assert.equal((await f.rows()).length, 0);
  for (const table of ['intake_event', 'intake_delivery', 'audit_entry']) {
    const rows = await bot.em.fork().execute<{ count: number }[]>(`select count(*)::integer as count from ${table} where installation_id=?`, [f.scope.installationId]);
    assert.equal(rows[0]!.count, 0);
  }
});

test('retention erases channel text and terminal metadata while unknown receipts keep their source references', async () => {
  const f = await fixture(); f.state.outcome = { state: 'UNKNOWN', reason: 'lost_response' };
  await f.service.receiveInput(f.message(), signal);
  f.state.outcome = { state: 'CONFIRMED', channelId: '980000000000000900' };
  await f.service.receiveInput(f.message('Yuna create a vc Other'), signal);
  const at = new Date(Date.now() + 8 * 86400_000);
  await bot.em.fork().transactional(async em => {
    await f.lifecycle.lockPrivacy(em, f.scope);
    await f.service.cleanup(em, at); await f.intake.purgeExpired(em, f.scope, at); await em.flush();
    assert.equal(await f.intake.purgeMetadata(em, f.scope, at), 1);
  });
  const rows = await f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0]!.state, 'UNKNOWN'); assert.equal(rows[0]!.operation, null);
});

/** Run the production durable generation path with a controlled JSON proposal and captured disclosure. */
async function planned(f: Awaited<ReturnType<typeof fixture>>, allowed = true, ownContext = true) {
  f.state.planning = true; f.state.allowed = allowed;
  const conversation = new ConversationService(bot, f.scope, 'chore-test', f.lifecycle, f.intake, new TaskService());
  conversation.setAdminAssistant(f.service);
  const message = f.message('Yuna, put that VC in the appropriate voice channels category');
  const context = chatContext(message); if (ownContext) context.messages[0]!.authorId = message.authorId;
  assert.equal(await conversation.receiveInput({ ...message, chatContext: context, previousReply: 'I moved everything already.' }), 'admitted');
  const store = new WorkerTaskStore(worker), claim = await store.claimNext('admin-worker', 'chore-test'); assert.ok(claim);
  const input = await store.releasePreparedInput(claim); assert.ok(input);
  assert.equal(Boolean(input.adminContext), allowed);
  if (allowed) {
    assert.equal(input.previousReply, undefined);
    assert.equal(input.chatContext?.messages.length, ownContext ? 1 : 0);
  }
  assert.equal(await store.recordProviderStart(claim), true);
  const text = JSON.stringify({ type: 'action', intentQuote: message.text,
    intent: { kind: 'move', channelId: '980000000000000900', parentId: '980000000000000902' } });
  assert.equal(await store.recordResult(claim, { outcome: 'success', reason: 'completed', payload: { text, providerRequestId: 'fixture',
    model: 'chore-test', inputTokens: 10, outputTokens: 10, totalTokens: 20, truncated: false } }), 'stored');
  return { conversation, message, context, input };
}

test('natural admin intent commits with result acknowledgment, executes once, and remembers only confirmed actions', async () => {
  const f = await fixture(), p = await planned(f);
  assert.equal(await p.conversation.acceptReplyResults(), 1);
  assert.equal((await f.rows())[0]?.state, 'READY'); assert.equal(f.state.writes, 0);
  assert.deepEqual(await bot.em.fork().execute('select id from reply_delivery where installation_id=?', [f.scope.installationId]), []);
  await f.service.runMaintenance(signal); await f.service.runMaintenance(signal);
  assert.equal(f.state.writes, 1); assert.deepEqual(f.state.replies, ['Moved <#980000000000000900>.']);
  assert.equal(await p.conversation.acceptReplyResults(), 0);
  const next = await f.service.readPlanningContext(f.message('Yuna rename that VC to Games'));
  assert.deepEqual(next?.recentActions, [{ kind: 'parent_id', channelId: '980000000000000900', state: 'CONFIRMED' }]);
});

test('ordinary users cannot acquire an action route through model JSON and other members cannot supply admin task context', async () => {
  const f = await fixture(), p = await planned(f, false);
  await p.conversation.acceptReplyResults(); await f.service.runMaintenance(signal);
  assert.equal((await f.rows()).length, 0); assert.equal(f.state.writes, 0);
  const g = await fixture(), q = await planned(g, true, false);
  assert.deepEqual(q.input.chatContext?.messages, []);
  await q.conversation.acceptReplyResults(); await g.service.runMaintenance(signal);
  assert.equal(g.state.writes, 1);
});

test.each(['source', 'context', 'settings', 'permission'] as const)('accepted admin plan is fenced by %s changes before dispatch', async change => {
  const f = await fixture(), p = await planned(f);
  if (change === 'permission') f.state.allowed = false;
  await p.conversation.acceptReplyResults();
  if (change === 'source' || change === 'context') await p.conversation.cancelRequest({ ...p.message,
    messageId: change === 'context' ? p.context.messages[0]!.id : p.message.messageId });
  if (change === 'settings') await bot.em.fork().transactional(async em => {
    await f.lifecycle.lockAdmission(em, f.scope);
    const settings = await p.conversation.readChannelSettings(em, p.message.channelId);
    await p.conversation.updateChannelSettings(em, { channelId: p.message.channelId, mode: 'silent', expectedRowRevision: settings.rowRevision }, new Date());
  });
  await f.service.runMaintenance(signal);
  assert.equal(f.state.writes, 0);
});

test('AI action audit failure rolls back the intent and completion acceptance together', async () => {
  const audit = new AuditRecorder(); let fail = true;
  const record = audit.recordTransition.bind(audit);
  audit.recordTransition = async (...args) => { if (fail) throw new Error('audit unavailable'); return record(...args); };
  const f = await fixture(audit), p = await planned(f);
  await assert.rejects(p.conversation.acceptReplyResults(), /audit unavailable/);
  assert.equal((await f.rows()).length, 0);
  assert.deepEqual(await bot.em.fork().execute('select id from task_acceptance where installation_id=?', [f.scope.installationId]), []);
  fail = false; assert.equal(await p.conversation.acceptReplyResults(), 1);
  await f.service.runMaintenance(signal); assert.equal(f.state.writes, 1);
});
