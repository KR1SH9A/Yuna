/** Operator controls exercise actual bot/worker privileges, owner invalidation, drain and immutable audit writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { defaultYunaPolicy } from '../../src/platform/config/policy-config.js';
import { AuthorityService } from '../../src/contexts/administration/authority.service.js';
import { ConfigurationService } from '../../src/contexts/administration/configuration.service.js';
import { SafetyService } from '../../src/contexts/administration/safety.service.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { UsagePolicy } from '../../src/contexts/administration/entities/usage-policy.entity.js';
import { GuildSafetyState } from '../../src/contexts/administration/entities/guild-safety-state.entity.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import { ConversationRequest } from '../../src/contexts/community/entities/conversation-request.entity.js';
import { ChannelReplySettings } from '../../src/contexts/community/entities/channel-reply-settings.entity.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { LlmService } from '../../src/ai/llm/llm.service.js';
import { AuditRecorder } from '../../src/platform/audit/audit.recorder.js';
import { AuditEntry } from '../../src/platform/audit/entities/audit-entry.entity.js';
import type { AdministrationFactReader } from '../../src/contexts/administration/contracts.js';
import type { NormalizedConversationMessage } from '../../src/discord/contracts.js';

let database: ReturnType<typeof temporaryPostgres>;
let bot: MikroORM, workerOrm: MikroORM;
let serial = 0;
const ownerId = '950000000000000001';

beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'admin-test-bot', workerDatabasePassword: 'admin-test-worker' });
  bot = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false });
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false });
  await bot.connect(); await workerOrm.connect();
}, 60_000);
afterAll(async () => { try { await bot?.close(true); await workerOrm?.close(true); } finally { database?.close(); } }, 30_000);

/** Compose real owners with a deterministic native-fact adapter and per-command transport identities. */
async function scenario() {
  serial++;
  const lifecycle = new GuildLifecycleService(bot), model = `controls-model-${serial}`;
  const scope = await lifecycle.registerGuild(String(960000000000000000n + BigInt(serial)), model);
  const tasks = new TaskService(), intake = new IntakeService();
  const conversation = new ConversationService(bot, scope, model, lifecycle, intake, tasks);
  let requestNumber = 0, failInvalidation = false;
  /** Bind a fixture user to this installation with independent request provenance. */
  const caller = () => ({ ...scope, actorId: ownerId, sourceRequestId: `controls:${serial}:${++requestNumber}` });
  const facts: AdministrationFactReader = { /** Supply deterministic native authority facts; no real Discord permissions are consulted. */ async readFacts(actor, operation) {
    assert.equal(bot.em.isInTransaction(), false);
    return { guildId: actor.guildId, actorId: actor.actorId, sourceRequestId: actor.sourceRequestId, operation,
      ownerId, observedAt: new Date(), complete: true, actorIsMember: true, actorPermissions: '8', botPermissions: '8' };
  } };
  const authority = new AuthorityService(bot, facts, async (em, event) => {
    await conversation.invalidatePending(em, event.kind, event.at);
    if (failInvalidation) throw new Error('invalidation_failed');
  });
  const safety = new SafetyService(bot, authority, async (em, event) => {
    await conversation.invalidatePending(em, event.kind, event.at);
    if (failInvalidation) throw new Error('invalidation_failed');
  });
  const configuration = new ConfigurationService(bot, authority, model, {
    /** Read only the channel whose scope Administration has already authorized. */
    readChannelSettings: (em, channelId) => conversation.readChannelSettings(em, channelId),
    updateChannelSettings: (em, input, at) => conversation.updateChannelSettings(em, input, at),
    readOperationalStatus: em => conversation.readOperationalStatus(em),
    /** Run or fail the fixture owner invalidation within the caller's transaction. */
    async invalidatePending(em, reason, at, channelId) {
      await conversation.invalidatePending(em, reason, at, channelId);
      if (failInvalidation) throw new Error('invalidation_failed');
    },
  });
  await authority.bootstrapOwner(caller());
  let messageNumber = 0;
  /** Build a unique normalized message for the current fixture installation. */
  const message = (channelId = '970000000000000001'): NormalizedConversationMessage => {
    const text = `Private source ${serial}:${++messageNumber}`;
    return { ...scope, channelId, messageId: String(970000000000000100n + BigInt(serial * 10 + messageNumber)), authorId: '970000000000000002', text,
      sourceHash: createHash('sha256').update(text).digest('hex'), createdAt: new Date() };
  };
  return { scope, model, lifecycle, conversation, authority, safety, configuration, caller, message,
    worker: new WorkerTaskStore(workerOrm), /** Arm the fixture failure used to prove transaction rollback during invalidation or cleanup. */ failCleanup() { failInvalidation = true; } };
}

test('channel mode updates use expected revisions, invalidate only that channel and audit no payload', async () => {
  const f = await scenario(), a = f.message(), b = f.message('970000000000000003');
  await f.conversation.receiveInput(a); await f.conversation.receiveInput(b);
  const changed = await f.configuration.updateChannelSettings(f.caller(), { channelId: a.channelId, mode: 'silent', expectedRowRevision: 1 });
  assert.deepEqual(changed, { channelId: a.channelId, mode: 'silent', rowRevision: 2 });
  await assert.rejects(f.configuration.updateChannelSettings(f.caller(), { channelId: a.channelId, mode: 'direct', expectedRowRevision: 1 }), /Stale settings revision/);
  assert.equal((await bot.em.fork().findOneOrFail(ConversationRequest, { ...f.scope, sourceMessageId: a.messageId })).stage, 'canceled');
  assert.equal((await bot.em.fork().findOneOrFail(ConversationRequest, { ...f.scope, sourceMessageId: b.messageId })).stage, 'generating');
  const audit = await bot.em.fork().find(AuditEntry, f.scope);
  assert.ok(audit.some(entry => entry.operation === 'community.channel_settings'));
  assert.ok(audit.every(entry => !JSON.stringify(entry).includes(a.text) && !JSON.stringify(entry).includes(b.text)));
  assert.equal(await f.conversation.receiveInput(f.message(a.channelId)), 'ignored');
});

test('revision zero creates a new channel configuration without enabling proactive participation', async () => {
  const f = await scenario();
  const result = await f.configuration.updateChannelSettings(f.caller(), { channelId: '990', mode: 'silent', expectedRowRevision: 0 });
  assert.equal(result.rowRevision, 1);
  await assert.rejects(f.configuration.updateChannelSettings(f.caller(), { channelId: '990', mode: 'direct', expectedRowRevision: 0 }), /current revision/);
  await assert.rejects(f.configuration.updateChannelSettings(f.caller(), { channelId: '991', mode: 'proactive' as 'direct', expectedRowRevision: 0 }), /Unsupported/);
  assert.equal(await bot.em.fork().count(ChannelReplySettings, f.scope), 1);
});

test('channel status exposes exact revisions without creating defaults and honors scoped grants while paused', async () => {
  const f = await scenario(), source = f.message(), selected = { channelId: source.channelId };
  assert.deepEqual(await f.configuration.readChannelSettings(f.caller(), selected), { ...selected, mode: 'direct', rowRevision: 0 });
  assert.equal(await bot.em.fork().count(ChannelReplySettings, f.scope), 0);
  await f.conversation.receiveInput(source);
  assert.equal((await f.configuration.readChannelSettings(f.caller(), selected)).rowRevision, 1);
  await f.configuration.updateChannelSettings(f.caller(), { ...selected, mode: 'silent', expectedRowRevision: 1 });
  assert.deepEqual(await f.configuration.readChannelSettings(f.caller(), selected), { ...selected, mode: 'silent', rowRevision: 2 });
  const grantee = { ...f.caller(), actorId: '990002' };
  await assert.rejects(f.configuration.readChannelSettings(grantee, selected));
  await f.authority.grantCapability(f.caller(), { granteeUserId: grantee.actorId, capability: 'community.configure',
    scope: { channelIds: [source.channelId], targetUserIds: [] }, sourceOperationKey: 'channel-read', expiresAt: null });
  await f.safety.pauseGuild(f.caller(), { expectedSafetyRevision: 0, reasonCode: 'operator_pause' });
  assert.equal((await f.configuration.readChannelSettings(grantee, selected)).rowRevision, 2);
  await assert.rejects(f.configuration.readChannelSettings(grantee, { channelId: '990003' }));
  assert.equal(await bot.em.fork().count(ChannelReplySettings, f.scope), 1);
  const operation = { capability: 'community.configure', channelId: source.channelId } as const;
  const facts = await f.authority.readCurrentFacts(grantee, operation);
  await bot.em.fork().transactional(async em => {
    const read = await f.authority.authorizeInTransaction(em, grantee, operation, facts, 'status');
    assert.ok(read.allowed);
    assert.equal(await f.authority.validateGrantRevision(em, read.authority, facts), false);
    await assert.rejects(f.authority.authorizeInTransaction(em, grantee, { capability: 'community.configure' }, facts, 'status'), /read-only management/);
    await assert.rejects(f.authority.authorizeInTransaction(em, grantee, { ...operation, targetUserId: '990004' }, facts, 'status'), /read-only management/);
  });
});

test('configuration is authorized, persisted and revision checked with usage and cancellation in one transaction', async () => {
  const f = await scenario(); await f.conversation.receiveInput(f.message());
  const config = structuredClone(defaultYunaPolicy); config.usage.dailyAttemptLimit = 12; config.retention.metadataDays = 14;
  const changed = await f.configuration.applyConfiguration(f.caller(), config, 0);
  assert.deepEqual(changed, { policyRevision: 1, usagePolicyRevision: 1, changed: true });
  const installed = await bot.em.fork().findOneOrFail(GuildInstallation, { id: f.scope.installationId });
  assert.deepEqual(installed.operatorPolicy, config);
  assert.equal((await bot.em.fork().findOneOrFail(UsagePolicy, f.scope)).limits[0]!.budgetKey, 'conversation.daily-attempts:12');
  assert.equal((await bot.em.fork().findOneOrFail(GuildSafetyState, f.scope)).safetyRevision, 1);
  const repeat = await f.configuration.applyConfiguration(f.caller(), config, 0);
  assert.equal(repeat.changed, false);
  const different = structuredClone(config); different.usage.dailyAttemptLimit = 11;
  await assert.rejects(f.configuration.applyConfiguration(f.caller(), different, 0), /Stale operator policy revision/);
  assert.equal((await f.configuration.status(f.caller())).pendingRequests, 0);
  const audit = await bot.em.fork().findOneOrFail(AuditEntry, { ...f.scope, operation: 'administration.configure' });
  assert.equal(audit.purgeAfter.getTime() - audit.occurredAt.getTime(), 14 * 86400_000);
});

test('competing configuration revisions commit one policy and one usage change', async () => {
  const f = await scenario(); const first = structuredClone(defaultYunaPolicy), second = structuredClone(defaultYunaPolicy);
  first.usage.dailyAttemptLimit = 10; second.usage.dailyAttemptLimit = 11;
  const outcomes = await Promise.allSettled([f.configuration.applyConfiguration(f.caller(), first, 0), f.configuration.applyConfiguration(f.caller(), second, 0)]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal((await bot.em.fork().findOneOrFail(GuildInstallation, { id: f.scope.installationId })).policyRevision, 1);
  assert.equal((await bot.em.fork().findOneOrFail(UsagePolicy, f.scope)).policyRevision, 1);
});

test('failed owner invalidation rolls back configuration, usage, request cancellation and audit', async () => {
  const f = await scenario(), source = f.message(); await f.conversation.receiveInput(source); f.failCleanup();
  await assert.rejects(f.configuration.applyConfiguration(f.caller(), defaultYunaPolicy, 0), /invalidation_failed/);
  assert.equal((await bot.em.fork().findOneOrFail(GuildInstallation, { id: f.scope.installationId })).policyRevision, 0);
  assert.equal((await bot.em.fork().findOneOrFail(UsagePolicy, f.scope)).policyRevision, 0);
  assert.equal((await bot.em.fork().findOneOrFail(ConversationRequest, { ...f.scope, sourceMessageId: source.messageId })).stage, 'generating');
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'administration.configure' }), 0);
});

test('drain denies new admission while an existing task completes and its reply is delivered', async () => {
  const f = await scenario(), source = f.message(); await f.conversation.receiveInput(source);
  const before = await f.configuration.status(f.caller());
  const change = await f.configuration.setFeatureAdmission(f.caller(), { feature: 'community', enabled: false, disposition: 'drain', expectedRowRevision: before.installationRevision });
  assert.equal(change.admission, 'read_only');
  assert.equal(await f.conversation.receiveInput(f.message()), 'ignored');
  const claim = await f.worker.claimNext('drain-worker', f.model); assert.ok(claim);
  const input = await f.worker.releasePreparedInput(claim); assert.ok(input);
  assert.equal(await f.worker.recordProviderStart(claim), true);
  const response = await new LlmService({ mode: 'fake' }, 1000).generateReply(input);
  assert.equal(await f.worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload: response }), 'stored');
  assert.equal(await f.conversation.acceptReplyResults(), 1);
  let sends = 0;
  const delivery = new ReplyDeliveryService(bot, f.scope, f.lifecycle, new IntakeService(), {
    /** Return the simulated current Discord source and permission state. */
    async readSource() { return { exists: true, canSend: true, sourceHash: source.sourceHash }; },
    /** Capture one simulated send and return this scenario's chosen transport outcome. */
    async sendReply() { sends++; return { classification: 'delivered', messageId: '999999' }; }, /** Return only the remotely attributed fixture reply during reconciliation. */ async findReply() { return null; },
  });
  await delivery.recoverDueDeliveries(new AbortController().signal);
  assert.equal(sends, 1);
  const after = await f.configuration.status(f.caller());
  assert.equal(after.safetyRevision, before.safetyRevision);
  assert.equal(after.readyDeliveries, 0);
});

test('cancel disables admission and fences already claimed prepared input', async () => {
  const f = await scenario(); await f.conversation.receiveInput(f.message());
  const claim = await f.worker.claimNext('cancel-worker', f.model); assert.ok(claim);
  const before = await f.configuration.status(f.caller());
  await f.configuration.setFeatureAdmission(f.caller(), { feature: 'community', enabled: false, disposition: 'cancel', expectedRowRevision: before.installationRevision });
  assert.equal(await f.worker.releasePreparedInput(claim), null);
  assert.equal((await f.configuration.status(f.caller())).safetyRevision, before.safetyRevision + 1);
});

test('pause/resume and grant changes audit atomically, retaining no source or reason payload', async () => {
  const f = await scenario(), source = f.message(); await f.conversation.receiveInput(source);
  const grant = await f.authority.grantCapability(f.caller(), { granteeUserId: '990001', capability: 'guild.pause',
    scope: { channelIds: [], targetUserIds: [] }, sourceOperationKey: 'grant', expiresAt: null });
  await f.authority.revokeGrant(f.caller(), { grantId: grant.grantId, expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'operator_request' });
  await f.safety.pauseGuild(f.caller(), { expectedSafetyRevision: 1, reasonCode: 'operator_pause' });
  await f.safety.resumeGuild(f.caller(), { expectedSafetyRevision: 2 });
  const operations = (await bot.em.fork().find(AuditEntry, f.scope)).map(entry => entry.operation).sort();
  assert.deepEqual(operations, ['administration.grant', 'administration.owner_bootstrap', 'administration.pause', 'administration.resume', 'administration.revoke']);
  f.failCleanup();
  await assert.rejects(f.safety.pauseGuild(f.caller(), { expectedSafetyRevision: 3, reasonCode: 'rollback' }), /invalidation_failed/);
  assert.equal(await bot.em.fork().count(AuditEntry, f.scope), 5);
});

test('audit writes are transaction-only, immutable on replay and roll back with their owner', async () => {
  const f = await scenario(), audit = new AuditRecorder(), caller = f.caller(), now = new Date();
  const references = [{ owner: 'administration', recordId: f.scope.installationId, revision: 0 }];
  await assert.rejects(audit.recordControlChange(bot.em.fork(), caller, 'administration.fixture', references, now), /owning transaction/);
  const id = await bot.em.fork().transactional(em => audit.recordControlChange(em, caller, 'administration.fixture', references, now));
  assert.equal(await bot.em.fork().transactional(em => audit.recordControlChange(em, caller, 'administration.fixture', references, now)), id);
  await assert.rejects(bot.em.fork().transactional(em => audit.recordControlChange(em, caller, 'administration.fixture', [{ ...references[0]!, revision: 1 }], now)), /replay payload mismatch/);
  await assert.rejects(bot.em.fork().transactional(async em => { await audit.recordControlChange(em, f.caller(), 'administration.rollback', references, now); throw new Error('owner_failed'); }), /owner_failed/);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'administration.rollback' }), 0);
});

test('removal recovery returns the old generation without making it available or reactivating it', async () => {
  const f = await scenario();
  await bot.em.fork().transactional(async em => {
    const installation = await em.findOneOrFail(GuildInstallation, { id: f.scope.installationId });
    installation.beginRemoval(['community'], 'operator_request', new Date());
    installation.recordAvailability('unavailable', new Date());
  });
  await assert.rejects(f.lifecycle.registerGuild(f.scope.guildId, f.model), /removal is still in progress/);
  assert.deepEqual(await f.lifecycle.registerGuild(f.scope.guildId, f.model, { resumeRemoval: true }), f.scope);
  const installed = await bot.em.fork().findOneOrFail(GuildInstallation, { id: f.scope.installationId });
  assert.equal(installed.state, 'removing'); assert.equal(installed.discordAvailability, 'unavailable');
});

test('audit expiry deletes bounded pages and removal explicitly retains records inside their lifetime', async () => {
  const f = await scenario(), audit = new AuditRecorder(), old = new Date(Date.now() - 8 * 86400_000);
  await bot.em.fork().transactional(async em => {
    for (let index = 0; index < 2; index++) await audit.recordControlChange(em, f.caller(), 'test.expired_audit', [], old, 7);
  });
  await assert.rejects(audit.purgeExpired(bot.em.fork(), f.scope), /owner transaction/);
  await bot.em.fork().transactional(async em => {
    assert.equal(await audit.purgeExpired(em, f.scope, new Date(), 1), 1);
  });
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'test.expired_audit' }), 1);
  await bot.em.fork().transactional(async em => {
    const result = await audit.cleanupForRemoval(em, f.scope, new Date());
    assert.equal(result.disposition, 'retained'); assert.equal(result.reasonCode, 'audit_retention_until_expiry');
  });
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'test.expired_audit' }), 0);
});
