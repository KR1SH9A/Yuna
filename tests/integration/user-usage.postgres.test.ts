/** Verify personal caps using real restricted worker claims, exact money, concurrent requests and unknown provider outcomes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { UsagePolicy } from '../../src/contexts/administration/entities/usage-policy.entity.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { UserUsageService } from '../../src/platform/usage/user-usage.service.js';
import { createConversationUsagePolicy } from '../../src/platform/usage/conversation-usage.js';
import { defaultYunaPolicy } from '../../src/platform/config/policy-config.js';
import type { JsonObject } from '../../src/platform/db/entity-values.js';

let database: ReturnType<typeof temporaryPostgres>, bot: MikroORM, workerOrm: MikroORM, worker: WorkerTaskStore, serial = 0;
const member = '987000000000000001', other = '987000000000000002';
beforeAll(async () => {
  database = temporaryPostgres(); const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'fixture-bot', workerDatabasePassword: 'fixture-worker' });
  bot = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false, logger: () => {} });
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false, logger: () => {} });
  await Promise.all([bot.connect(), workerOrm.connect()]); worker = new WorkerTaskStore(workerOrm);
}, 60000);
afterAll(async () => { try { await Promise.all([bot?.close(true), workerOrm?.close(true)]); } finally { database?.close(); } }, 30000);

/** Install a bounded test policy under real owner locks; only provider behavior is omitted from these accounting tests. */
async function fixture(money = false) {
  serial++; const model = `quota-model-${serial}`, lifecycle = new GuildLifecycleService(bot);
  const scope = await lifecycle.registerGuild(String(987100000000000000n + BigInt(serial)), model);
  const config = structuredClone(defaultYunaPolicy);
  config.usage.dailyAttemptLimit = 1000;
  config.usage.userDefaults = { dailyAttemptLimit: 10, dailyBudget: money ? { amount: '0.10', currency: 'USD' } : null };
  if (money) config.usage.prices = [{ provider: 'deepseek', model, version: 'fixture-v1', currency: 'USD', inputPerMillion: '1', outputPerMillion: '1', maxInputTokens: 65536, maxOutputTokens: 1024 }];
  await bot.em.fork().transactional(async em => {
    await lifecycle.lockAdmission(em, scope); const installation = await em.findOneOrFail(GuildInstallation, { id: scope.installationId });
    installation.updateOperatorPolicy(0, config as unknown as JsonObject, new Date());
    const usage = await em.findOneOrFail(UsagePolicy, scope), template = createConversationUsagePolicy(scope, new Date(), model, 1000, config.usage);
    usage.revise({ schemaVersion: 1, limits: template.limits, windowRules: template.windowRules, perAttemptBounds: template.perAttemptBounds }, usage.policyRevision, { kind: 'system', operation: 'test-configure' }, new Date());
  });
  const service = new UserUsageService(bot, scope), conversation = new ConversationService(bot, scope, model, lifecycle, new IntakeService(), new TaskService());
  let requests = 0;
  /** Bind a fixture user to this installation with independent request provenance. */
  const caller = (actorId = member) => ({ ...scope, actorId, sourceRequestId: `quota:${serial}:${++requests}` });
  /** Resolve the checkpoint only after its exact notification marker arrives. */
  const receive = async (actorId = member) => {
    const text = `Quota fixture ${serial}:${++requests}`;
    return conversation.receiveInput({ ...scope, channelId: '987000000000000003', messageId: String(987000000000000100n + BigInt(serial * 100 + requests)),
      authorId: actorId, text, sourceHash: createHash('sha256').update(text).digest('hex'), createdAt: new Date() });
  };
  return { scope, model, service, caller, receive };
}

test('two competing claims consume one personal slot and cannot charge another member', async () => {
  const f = await fixture(); await f.service.setLimit(f.caller(), { dailyAttemptLimit: 1 });
  await f.receive(); await f.receive(); await f.receive(other);
  const claims = await Promise.all([worker.claimNext('one', f.model), worker.claimNext('two', f.model), worker.claimNext('three', f.model)]);
  assert.equal(claims.filter(Boolean).length, 2);
  const a = await f.service.readStatus(f.caller()), b = await f.service.readStatus(f.caller(other));
  assert.equal(a.attemptsUsed, 1); assert.equal(a.attemptsRemaining, 0); assert.equal(b.attemptsUsed, 1);
  assert.equal(a.committedAmount, null); assert.equal(a.unknownCostAttempts, 1);
});

test('personal limits can stop new claims but never enlarge the server member quota', async () => {
  const f = await fixture();
  assert.equal((await f.service.setLimit(f.caller(), { dailyAttemptLimit: 1000 })).attemptLimit, 10);
  await f.service.setLimit(f.caller(), { dailyAttemptLimit: 0 }); await f.receive();
  assert.equal(await worker.claimNext('stopped', f.model), null);
  assert.equal((await f.service.clearLimit(f.caller())).attemptLimit, 10);
  assert.ok(await worker.claimNext('resumed', f.model));
});

test('exact reservation blocks a second call while uncertain spend remains fully charged', async () => {
  const f = await fixture(true); await f.receive(); await f.receive();
  const first = await worker.claimNext('money', f.model); assert.ok(first);
  assert.ok(await worker.releasePreparedInput(first)); assert.equal(await worker.recordProviderStart(first), true);
  await worker.recordResult(first, { outcome: 'uncertain', reason: 'timeout' });
  assert.equal(await worker.claimNext('overspend', f.model), null);
  const status = await f.service.readStatus(f.caller());
  assert.equal(status.dailyBudget?.amount, '0.10'); assert.equal(status.committedAmount, '0.066560000000000000');
});

test('enabling a personal money cap rejects unpriced work, including previously unresolved usage', async () => {
  const f = await fixture(); await f.receive(); assert.ok(await worker.claimNext('unpriced', f.model));
  await f.service.setLimit(f.caller(), { dailyBudget: { amount: '1', currency: 'USD' } }); await f.receive();
  assert.equal(await worker.claimNext('guarded', f.model), null);
  assert.equal((await f.service.readStatus(f.caller())).unknownCostAttempts, 1);
});

test('request scope, decimal validation and member preferences remain isolated', async () => {
  const f = await fixture(true);
  await assert.rejects(f.service.readStatus({ ...f.caller(), guildId: '987000000000000099' }), /scope mismatch/);
  await assert.rejects(f.service.setLimit(f.caller(), { dailyBudget: { amount: '0.1', currency: 'INR' } }), /currency/);
  await assert.rejects(f.service.setLimit(f.caller(), { dailyBudget: { amount: 'NaN', currency: 'USD' } }), /decimal/);
  await f.service.setLimit(f.caller(), { dailyAttemptLimit: 2, dailyBudget: { amount: '0.01', currency: 'USD' } });
  assert.equal((await f.service.readStatus(f.caller(other))).personalLimit, null);
  await bot.em.fork().transactional(em => f.service.cleanupForRemoval(em));
  assert.equal((await f.service.readStatus(f.caller())).personalLimit, null);
});

test('a changed server currency never relabels an old personal budget as a new currency', async () => {
  const f = await fixture(); await f.service.setLimit(f.caller(), { dailyBudget: { amount: '1', currency: 'USD' } });
  await bot.em.fork().transactional(async em => {
    const row = await em.findOneOrFail(GuildInstallation, { id: f.scope.installationId });
    const config = structuredClone(row.operatorPolicy!); (config.usage as JsonObject).userDefaults = { dailyAttemptLimit: 10, dailyBudget: { amount: '100', currency: 'INR' } };
    row.updateOperatorPolicy(row.policyRevision, config, new Date());
  });
  const status = await f.service.readStatus(f.caller());
  assert.equal(status.blockedReason, 'personal_currency_mismatch'); assert.equal(status.dailyBudget, null);
  assert.equal(status.personalLimit?.dailyBudget?.currency, 'USD');
  await f.receive(); assert.equal(await worker.claimNext('mismatched-currency', f.model), null);
});


test("simultaneous priced claims cannot jointly exceed one member's monetary allowance", async () => {
  const f = await fixture(true); await f.receive(); await f.receive();
  const claims = await Promise.all([worker.claimNext('budget-lane-1', f.model), worker.claimNext('budget-lane-2', f.model)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await f.service.readStatus(f.caller())).committedAmount, '0.066560000000000000');
});
