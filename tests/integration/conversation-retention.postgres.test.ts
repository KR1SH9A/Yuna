/** Verify bounded graph erasure preserves uncertain delivery/accounting and unfinished source-owner receipts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { GuildLifecycleService, type InstallationScope } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { UsagePolicy } from '../../src/contexts/administration/entities/usage-policy.entity.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import { ConversationRequest } from '../../src/contexts/community/entities/conversation-request.entity.js';
import { ReplyDelivery } from '../../src/contexts/community/entities/reply-delivery.entity.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { IntakeEvent } from '../../src/platform/intake/entities/intake-event.entity.js';
import { IntakeDelivery } from '../../src/platform/intake/entities/intake-delivery.entity.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { createConversationUsagePolicy } from '../../src/platform/usage/conversation-usage.js';
import type { NormalizedConversationMessage } from '../../src/discord/contracts.js';

let database: ReturnType<typeof temporaryPostgres>;
let bot: MikroORM, workerOrm: MikroORM;
let serial = 0;
const day = 86_400_000;
const graphTables = ['conversation_request', 'reply_delivery', 'ai_task', 'prepared_input', 'task_attempt', 'task_result',
  'task_acceptance', 'outbox_entry', 'usage_reservation', 'usage_entry', 'intake_event', 'intake_delivery'] as const;

beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'retention-test-bot', workerDatabasePassword: 'retention-test-worker' });
  bot = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false });
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false });
  await Promise.all([bot.connect(), workerOrm.connect()]);
}, 60_000);

afterAll(async () => {
  try { await Promise.all([bot?.close(true), workerOrm?.close(true)]); }
  finally { database?.close(); }
}, 30_000);

/** Count every linked graph table through a fresh connection so stale ORM identity maps cannot hide failed deletes. */
async function graphCounts(scope: InstallationScope): Promise<Record<typeof graphTables[number], number>> {
  const entries = await Promise.all(graphTables.map(async table => {
    const rows = await bot.em.fork().execute<{ count: number }[]>(`select count(*)::integer as count from ${table} where installation_id=? and guild_id=?`,
      [scope.installationId, scope.guildId]);
    return [table, rows[0]!.count] as const;
  }));
  return Object.fromEntries(entries) as Record<typeof graphTables[number], number>;
}

/** Build an acknowledged real task; only native provider and Discord results are deterministic fixtures. */
async function scenario(accounting: 'no-spend' | 'priced' | 'unpriced' = 'priced', unknownSend = false) {
  serial++;
  const lifecycle = new GuildLifecycleService(bot), model = `retention-model-${serial}`;
  const scope = await lifecycle.registerGuild(String(940000000000000000n + BigInt(serial)), model);
  const intake = new IntakeService(), tasks = new TaskService(), worker = new WorkerTaskStore(workerOrm);
  const conversation = new ConversationService(bot, scope, model, lifecycle, intake, tasks);
  if (accounting === 'priced') await bot.em.fork().transactional(async em => {
    await lifecycle.lockAdmission(em, scope);
    const now = new Date(), policy = await em.findOneOrFail(UsagePolicy, scope);
    const selected = createConversationUsagePolicy(scope, now, model, 20, { dailyAttemptLimit: 20, dailyBudget: null,
      prices: [{ provider: 'deepseek', model, version: 'test-price-v1', currency: 'USD', inputPerMillion: '1',
        outputPerMillion: '1', maxInputTokens: 32768, maxOutputTokens: 512 }] });
    policy.revise({ schemaVersion: 1, limits: selected.limits, windowRules: selected.windowRules, perAttemptBounds: selected.perAttemptBounds },
      policy.policyRevision, { kind: 'system', operation: 'test-price' }, now);
  });
  const text = `Retention source ${serial}`;
  const message: NormalizedConversationMessage = { guildId: scope.guildId, channelId: '940000000000000100',
    messageId: String(940000000000001000n + BigInt(serial)), authorId: '940000000000000101', text,
    sourceHash: createHash('sha256').update(text).digest('hex'), createdAt: new Date() };
  assert.equal(await conversation.receiveInput(message), 'admitted');
  const claim = await worker.claimNext('retention-worker', model); assert.ok(claim);
  if (accounting === 'no-spend') {
    await conversation.cancelRequest(message);
    await tasks.recoverExpired(bot.em.fork());
  } else {
    assert.ok(await worker.releasePreparedInput(claim));
    assert.equal(await worker.recordProviderStart(claim), true);
    assert.equal(await worker.recordResult(claim, { outcome: 'success', reason: 'complete', payload: {
      text: 'Retained response', providerRequestId: `request-${serial}`, model, inputTokens: 10, outputTokens: 5, totalTokens: 15, truncated: false,
    } }), 'stored');
  }
  await conversation.acceptReplyResults();
  if (accounting !== 'no-spend') {
    const delivery = new ReplyDeliveryService(bot, scope, lifecycle, intake, {
      /** Return the simulated current Discord source and permission state. */
      async readSource() { return { exists: true, canSend: true, sourceHash: message.sourceHash }; },
      /** Capture one simulated send and return this scenario's chosen transport outcome. */
      async sendReply() { return unknownSend ? { classification: 'unknown', code: 'unconfirmed_send' }
        : { classification: 'delivered', messageId: '940000000000000102' }; },
      /** Return only the remotely attributed fixture reply during reconciliation. */
      async findReply() { return null; },
    }, tasks);
    await delivery.dispatchReadyDeliveries(new AbortController().signal);
  }
  const future = new Date(Date.now() + 40 * day);
  return { scope, lifecycle, intake, tasks, conversation, future,
    /** Use the same payload transitions as periodic maintenance, at an explicit future retention time. */
    async purgePayloads() {
      await bot.em.fork().transactional(async em => {
        await lifecycle.lockAdmission(em, scope);
        for (const row of await em.find(ConversationRequest, scope)) row.purgePayload('retention', row.rowRevision, future);
        for (const row of await em.find(ReplyDelivery, scope)) row.purgePayload('retention', row.rowRevision, future);
        await intake.purgeExpired(em, scope, future);
        await tasks.purgeExpired(em, scope, future);
      });
    },
    /** Community and Jobs delete reciprocal references atomically, then Intake may drop its terminal markers. */
    async purgeMetadata(failAfterDeletes = false) {
      return bot.em.fork().transactional(async em => {
        await lifecycle.lockAdmission(em, scope);
        const removed = await conversation.purgeMetadata(em, future, 7);
        const markers = await intake.purgeMetadata(em, scope, future);
        if (failAfterDeletes) throw new Error('metadata_commit_failed');
        return { removed, markers };
      });
    },
  };
}

test.each(['no-spend', 'priced'] as const)('acknowledged %s graphs erase all expired payloads and metadata in one commit', async accounting => {
  const f = await scenario(accounting), before = await graphCounts(f.scope);
  for (const table of graphTables.filter(table => table !== 'reply_delivery')) assert.ok(before[table] > 0, `${table} fixture must exist`);
  assert.equal(before.reply_delivery, accounting === 'no-spend' ? 0 : 1);
  const usage = await bot.em.fork().execute<{ accounting_state: string; state: string }[]>(`select e.accounting_state,r.state
    from usage_entry e join usage_reservation r on r.id=e.reservation_id where r.installation_id=?`, [f.scope.installationId]);
  assert.equal(usage[0]?.accounting_state, accounting === 'no-spend' ? 'no-spend' : 'actual');
  await f.purgePayloads();
  assert.deepEqual(await f.purgeMetadata(), { removed: 1, markers: 1 });
  assert.deepEqual(await graphCounts(f.scope), Object.fromEntries(graphTables.map(table => [table, 0])));
  assert.deepEqual(await f.purgeMetadata(), { removed: 0, markers: 0 });
});

test('a metadata commit failure restores the entire acknowledged graph and accounting for a safe retry', async () => {
  const f = await scenario(); await f.purgePayloads();
  const before = await graphCounts(f.scope);
  await assert.rejects(f.purgeMetadata(true), /metadata_commit_failed/);
  assert.deepEqual(await graphCounts(f.scope), before);
  assert.deepEqual(await f.purgeMetadata(), { removed: 1, markers: 1 });
  assert.ok(Object.values(await graphCounts(f.scope)).every(count => count === 0));
});

test('uncertain Discord delivery and unresolved provider accounting retain their graph despite elapsed metadata retention', async () => {
  for (const [accounting, unknownSend] of [['priced', true], ['unpriced', false]] as const) {
    const f = await scenario(accounting, unknownSend); await f.purgePayloads();
    const before = await graphCounts(f.scope);
    assert.deepEqual(await f.purgeMetadata(), { removed: 0, markers: 0 });
    assert.deepEqual(await graphCounts(f.scope), before);
    if (unknownSend) assert.equal((await bot.em.fork().findOneOrFail(ReplyDelivery, f.scope)).state, 'UNKNOWN');
    else {
      const rows = await bot.em.fork().execute<{ state: string }[]>('select state from usage_reservation where installation_id=?', [f.scope.installationId]);
      assert.equal(rows[0]?.state, 'liability');
    }
  }
});

test('elapsed metadata age cannot delete records while their retained payloads remain present', async () => {
  const f = await scenario(), before = await graphCounts(f.scope);
  assert.deepEqual(await f.purgeMetadata(), { removed: 0, markers: 0 });
  assert.deepEqual(await graphCounts(f.scope), before);
  assert.equal((await bot.em.fork().findOneOrFail(ConversationRequest, f.scope)).payloadPurgedAt, null);
});

test('an unfinished owner receipt keeps an erased source marker until the owner records a terminal disposition', async () => {
  serial++;
  const lifecycle = new GuildLifecycleService(bot), scope = await lifecycle.registerGuild(String(940000000000000000n + BigInt(serial)), 'marker-retention');
  const intake = new IntakeService(), now = new Date(), future = new Date(now.getTime() + 40 * day);
  let eventId!: string;
  await bot.em.fork().transactional(async em => {
    await lifecycle.lockAdmission(em, scope);
    const event = new IntakeEvent({ ...scope, createdAt: now, eventKind: 'message_create', sourceEventKey: `retention:${serial}`,
      sourceKey: `marker:${serial}`, ingressSequence: 1n, observedAt: now, authorKind: 'unknown', contentAccess: 'unknown', coverage: [],
      purgeAfter: new Date(now.getTime() + day), metadataPurgeAfter: new Date(now.getTime() + 7 * day) });
    event.markCurrent(1, 'unresolved'); event.purgePayload(future, 'retention'); eventId = event.id;
    em.persist([event, new IntakeDelivery({ ...scope, createdAt: now, eventId, owner: 'memory', orderKey: event.sourceKey! })]);
  });
  assert.equal(await bot.em.fork().transactional(async em => {
    await lifecycle.lockAdmission(em, scope); return intake.purgeMetadata(em, scope, future);
  }), 0);
  assert.equal(await bot.em.fork().count(IntakeEvent, { ...scope, id: eventId }), 1);
  await bot.em.fork().transactional(async em => {
    await lifecycle.lockAdmission(em, scope);
    const receipt = await em.findOneOrFail(IntakeDelivery, { ...scope, eventId });
    receipt.disposeUnavailable('expired', 'retention_elapsed', future, receipt.rowRevision);
  });
  assert.equal(await bot.em.fork().transactional(async em => {
    await lifecycle.lockAdmission(em, scope); return intake.purgeMetadata(em, scope, future);
  }), 1);
  assert.equal(await bot.em.fork().count(IntakeDelivery, { ...scope, eventId }), 0);
});
