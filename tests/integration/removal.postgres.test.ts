/** Exercise removal authority, transaction fences, resumable erasure and reinstall isolation with real PostgreSQL roles. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { AuthorityService } from '../../src/contexts/administration/authority.service.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { RemovalService, type RemovalOwner } from '../../src/contexts/administration/removal.service.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { GuildSafetyState } from '../../src/contexts/administration/entities/guild-safety-state.entity.js';
import { CapabilityGrant } from '../../src/contexts/administration/entities/capability-grant.entity.js';
import type { AdministrationFactReader } from '../../src/contexts/administration/contracts.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { ConversationRequest } from '../../src/contexts/community/entities/conversation-request.entity.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { IntakeEvent } from '../../src/platform/intake/entities/intake-event.entity.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { PreparedInput } from '../../src/platform/jobs/entities/prepared-input.entity.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { AuditRecorder } from '../../src/platform/audit/audit.recorder.js';
import { AuditEntry } from '../../src/platform/audit/entities/audit-entry.entity.js';
import { createBotOwnership } from '../../src/platform/runtime/bot-ownership.js';
import type { NormalizedConversationMessage } from '../../src/discord/contracts.js';

let database: ReturnType<typeof temporaryPostgres>;
let bot: MikroORM, workerOrm: MikroORM, inspector: MikroORM;
let serial = 0;
const ownerId = '930000000000000001', otherActor = '930000000000000002';

beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'removal-test-bot', workerDatabasePassword: 'removal-test-worker' });
  bot = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false });
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false });
  inspector = new MikroORM({ ...database.options, entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false });
  await Promise.all([bot.connect(), workerOrm.connect(), inspector.connect()]);
}, 60_000);

afterAll(async () => {
  try { await Promise.all([bot?.close(true), workerOrm?.close(true), inspector?.close(true)]); }
  finally { database?.close(); }
}, 30_000);

/** Promise checkpoints choose the race winner; elapsed time only bounds a broken fixture. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

/** Always release held locks in finally blocks if a checkpoint cannot be reached. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Removal race checkpoint did not complete')), 4000);
  })]); } finally { clearTimeout(timer); }
}

/** Observe a real PostgreSQL dependency instead of assuming a concurrent request has reached its lock. */
async function waitForBlockedBy(pid: number): Promise<void> {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const rows = await inspector.em.fork().execute<{ blocked: boolean }[]>(
      'select exists(select 1 from pg_stat_activity where ? = any(pg_blocking_pids(pid))) as blocked', [pid]);
    if (rows[0]?.blocked) return;
  }
  assert.fail('The contender never waited on the removal transaction');
}

/** Inject only native facts/failures; installation, grants, source intake, tasks and cleanup use production owners. */
async function scenario(bootstrap = true) {
  serial += 1;
  const lifecycle = new GuildLifecycleService(bot), model = `removal-model-${serial}`;
  const scope = await lifecycle.registerGuild(String(930000000000000100n + BigInt(serial)), model);
  const tasks = new TaskService(), intake = new IntakeService();
  const conversation = new ConversationService(bot, scope, model, lifecycle, intake, tasks);
  const native = { ownerId, complete: true, stale: false };
  let requestNumber = 0, messageNumber = 0;
  /** Bind a fixture user to this installation with independent request provenance. */
  const caller = (actorId = ownerId) => ({ ...scope, actorId, sourceRequestId: `remove:${serial}:${++requestNumber}` });
  const facts: AdministrationFactReader = { /** Supply deterministic native authority facts; no real Discord permissions are consulted. */ async readFacts(actor, operation) {
    assert.equal(bot.em.isInTransaction(), false);
    return { guildId: actor.guildId, actorId: actor.actorId, sourceRequestId: actor.sourceRequestId, operation,
      ownerId: native.ownerId, observedAt: new Date(Date.now() - (native.stale ? 6000 : 0)), complete: native.complete,
      actorIsMember: true, actorPermissions: '8', botPermissions: '8' };
  } };
  const authority = new AuthorityService(bot, facts, (em, event) => conversation.invalidatePending(em, event.kind, event.at));
  if (bootstrap) await authority.bootstrapOwner(caller());
  const controls = { failInvalidation: false, failCleanup: false, pending: false };
  let gate: { entered: ReturnType<typeof deferred<number>>; release: ReturnType<typeof deferred<void>> } | null = null;
  const calls = { community: 0, intake: 0, jobs: 0, liability: 0 };
  const owners: Readonly<Record<string, RemovalOwner>> = {
    community: {
      /** Simulate this cleanup owner's invalidation inside the removal transaction. */
      async invalidate(em, at) {
        assert.equal(em.isInTransaction(), true);
        await conversation.invalidatePending(em, 'installation_removal', at);
        if (gate) {
          const rows = await em.execute<{ pid: number }[]>('select pg_backend_pid() as pid');
          gate.entered.resolve(rows[0]!.pid);
          await bounded(gate.release.promise);
        }
        if (controls.failInvalidation) throw new Error('invalidation_failed');
      },
      /** Return this fixture owner's cleanup progress inside the removal transaction. */
      async cleanup(em, at) { calls.community++; return conversation.cleanupForRemoval(em, at); },
    },
    intake: { /** Simulate this cleanup owner's invalidation inside the removal transaction. */ async invalidate() {}, /** Return this fixture owner's cleanup progress inside the removal transaction. */ async cleanup(em, at) { calls.intake++; return intake.cleanupForRemoval(em, scope, at); } },
    jobs: { /** Simulate this cleanup owner's invalidation inside the removal transaction. */ async invalidate() {}, /** Return this fixture owner's cleanup progress inside the removal transaction. */ async cleanup(em, at) { calls.jobs++; return tasks.cleanupForRemoval(em, scope, at); } },
    liability: { /** Simulate this cleanup owner's invalidation inside the removal transaction. */ async invalidate() {}, /** Return this fixture owner's cleanup progress inside the removal transaction. */ async cleanup() {
      calls.liability++;
      if (controls.failCleanup) throw new Error('cleanup_interrupted');
      return controls.pending ? { disposition: 'pending', reasonCode: 'awaiting_receipt' }
        : { disposition: 'retained', reasonCode: 'accounting_liability' };
    } },
  };
  const removal = new RemovalService(bot, scope, authority, owners);
  /** Build a unique normalized message for the current fixture installation. */
  const message = (): NormalizedConversationMessage => {
    const text = `Private removal source ${serial}:${++messageNumber}`;
    return { guildId: scope.guildId, channelId: '930000000000000010', messageId: String(930000000000001000n + BigInt(serial * 100 + messageNumber)),
      authorId: otherActor, text, sourceHash: createHash('sha256').update(text).digest('hex'), createdAt: new Date() };
  };
  return { scope, model, lifecycle, tasks, conversation, authority, native, caller, controls, calls, owners, removal, message,
    worker: new WorkerTaskStore(workerOrm),
    installation: () => bot.em.fork().findOneOrFail(GuildInstallation, { id: scope.installationId }),
    safety: () => bot.em.fork().findOneOrFail(GuildSafetyState, scope),
    /** Pause owner invalidation so the test can observe a competing transaction waiting. */
    holdInvalidation() { assert.equal(gate, null); gate = { entered: deferred<number>(), release: deferred<void>() }; return gate; },
  };
}

test('removal requires current owner enrollment, complete fresh facts, exact scope and the confirmed installation revision', async () => {
  const f = await scenario(false), before = await f.installation();
  await assert.rejects(f.removal.beginRemoval(f.caller(), before.rowRevision), /application_grant_required/);
  await f.authority.bootstrapOwner(f.caller());
  await assert.rejects(f.removal.beginRemoval(f.caller(otherActor), before.rowRevision), /current_owner_required/);
  f.native.ownerId = otherActor;
  await assert.rejects(f.removal.beginRemoval(f.caller(), before.rowRevision), /current_owner_required/);
  f.native.ownerId = ownerId; f.native.complete = false;
  await assert.rejects(f.removal.beginRemoval(f.caller(), before.rowRevision), /native_facts_mismatch/);
  f.native.complete = true; f.native.stale = true;
  await assert.rejects(f.removal.beginRemoval(f.caller(), before.rowRevision), /native_facts_stale/);
  f.native.stale = false;
  await assert.rejects(f.removal.beginRemoval({ ...f.caller(), installationId: randomUUID() }, before.rowRevision), /Installation mismatch/);
  await assert.rejects(f.removal.beginRemoval(f.caller(), before.rowRevision + 1), /Stale installation revision/);
  await assert.rejects(f.removal.beginRemoval(f.caller(), 0), /Invalid installation revision/);
  assert.equal((await f.installation()).state, 'active');
  assert.equal((await f.safety()).safetyRevision, 0);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'installation.remove' }), 0);
});

test('committed removal atomically fences claimed disclosure and new admission behind its installation lock', async () => {
  const f = await scenario(), source = f.message();
  assert.equal(await f.conversation.receiveInput(source), 'admitted');
  const claim = await f.worker.claimNext('removal-worker', f.model); assert.ok(claim);
  const before = await f.installation(), gate = f.holdInvalidation();
  const removing = f.removal.beginRemoval(f.caller(), before.rowRevision);
  let admission: Promise<string> | undefined;
  try {
    const pid = await bounded(gate.entered.promise);
    admission = f.conversation.receiveInput(f.message());
    await bounded(waitForBlockedBy(pid));
    gate.release.resolve();
    const outcome = await removing;
    assert.equal(outcome.state, 'removing');
    assert.equal(outcome.installationRevision, before.rowRevision + 1);
    assert.equal(await admission, 'ignored');
    assert.equal(await f.worker.releasePreparedInput(claim), null);
    assert.equal(await f.worker.recordProviderStart(claim), false);
    const safety = await f.safety();
    assert.equal(safety.paused, true); assert.equal(safety.safetyRevision, 1);
    assert.equal((await bot.em.fork().findOneOrFail(ConversationRequest, { ...f.scope, sourceMessageId: source.messageId })).stage, 'canceled');
    const audit = await bot.em.fork().findOneOrFail(AuditEntry, { ...f.scope, operation: 'installation.remove', outcome: 'intent' });
    assert.ok(!JSON.stringify(audit).includes(source.text));
    assert.deepEqual((await f.installation()).requiredCleanupOwners, ['community', 'intake', 'jobs', 'liability']);
  } finally { gate.release.resolve(); await Promise.allSettled([removing, admission]); }
});

test('owner invalidation failure rolls removal, pause, task fencing and audit back together', async () => {
  const f = await scenario(), source = f.message(); await f.conversation.receiveInput(source);
  const claim = await f.worker.claimNext('rollback-worker', f.model); assert.ok(claim);
  const before = await f.installation(); f.controls.failInvalidation = true;
  await assert.rejects(f.removal.beginRemoval(f.caller(), before.rowRevision), /invalidation_failed/);
  const after = await f.installation();
  assert.equal(after.state, 'active'); assert.equal(after.rowRevision, before.rowRevision);
  assert.equal(after.removalStartedAt, null); assert.deepEqual(after.requiredCleanupOwners, []);
  assert.equal((await f.safety()).paused, false); assert.equal((await f.safety()).safetyRevision, 0);
  assert.equal((await bot.em.fork().findOneOrFail(ConversationRequest, f.scope)).stage, 'generating');
  assert.ok(await f.worker.releasePreparedInput(claim));
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'installation.remove' }), 0);
});

test('audit failure rolls back even after owner invalidation and the audit insert have run', async () => {
  const f = await scenario(); await f.conversation.receiveInput(f.message());
  const audit = new AuditRecorder();
  const original = audit.recordTransition.bind(audit);
  audit.recordTransition = async (em, input) => { await original(em, input); throw new Error('audit_commit_failed'); };
  const removal = new RemovalService(bot, f.scope, f.authority, f.owners, audit), before = await f.installation();
  await assert.rejects(removal.beginRemoval(f.caller(), before.rowRevision), /audit_commit_failed/);
  assert.equal((await f.installation()).state, 'active');
  assert.equal((await f.safety()).paused, false);
  assert.equal((await bot.em.fork().findOneOrFail(ConversationRequest, f.scope)).stage, 'generating');
  assert.equal((await bot.em.fork().findOneOrFail(PreparedInput, f.scope)).eligible, true);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'installation.remove' }), 0);
});

test('competing removal commands commit one intent and advance the safety fence once', async () => {
  const f = await scenario(), before = await f.installation();
  const outcomes = await Promise.allSettled([
    f.removal.beginRemoval(f.caller(), before.rowRevision), f.removal.beginRemoval(f.caller(), before.rowRevision),
  ]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(value => value.status === 'rejected').length, 1);
  assert.equal((await f.safety()).safetyRevision, 1);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'installation.remove', outcome: 'intent' }), 1);
});

test('interrupted cleanup rolls back payload erasure and resumes from durable owner progress after restart', async () => {
  const f = await scenario(); await f.conversation.receiveInput(f.message());
  await f.removal.beginRemoval(f.caller(), (await f.installation()).rowRevision);
  await f.tasks.recoverExpired(bot.em.fork());
  f.controls.failCleanup = true;
  await assert.rejects(f.removal.runCleanup(), /cleanup_interrupted/);
  assert.equal((await f.installation()).state, 'removing');
  assert.deepEqual((await f.installation()).cleanupProgress, {});
  assert.equal((await bot.em.fork().findOneOrFail(ConversationRequest, f.scope)).payloadPurgedAt, null);
  assert.ok((await bot.em.fork().findOneOrFail(PreparedInput, f.scope)).payload);
  assert.ok((await bot.em.fork().findOneOrFail(IntakeEvent, f.scope)).snapshot);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'installation.remove', outcome: 'succeeded' }), 0);
  f.controls.failCleanup = false;
  const restarted = new RemovalService(bot, f.scope, f.authority, f.owners);
  assert.equal(await restarted.runCleanup(), true);
  const removed = await f.installation();
  assert.equal(removed.state, 'removed'); assert.ok(removed.removedAt);
  assert.equal((await bot.em.fork().findOneOrFail(ConversationRequest, f.scope)).contextBindings, null);
  assert.equal((await bot.em.fork().findOneOrFail(PreparedInput, f.scope)).payload, null);
  assert.equal((await bot.em.fork().findOneOrFail(IntakeEvent, f.scope)).snapshot, null);
  assert.equal(removed.cleanupProgress.liability?.disposition, 'retained');
  assert.equal(removed.cleanupProgress.liability?.reasonCode, 'accounting_liability');
  assert.equal(await restarted.runCleanup(), false);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: 'installation.remove', outcome: 'succeeded' }), 1);
});

test('pending cleanup blocks reinstall, completed owners are skipped and removed generations cannot regain authority', async () => {
  const f = await scenario(), before = await f.installation();
  assert.equal(await f.removal.runCleanup(), false);
  f.controls.pending = true;
  await f.removal.beginRemoval(f.caller(), before.rowRevision);
  assert.equal(await f.removal.runCleanup(), false);
  const removing = await f.installation();
  assert.equal(removing.cleanupProgress.liability?.disposition, 'pending');
  assert.ok(removing.cleanupProgress.liability?.nextAttemptAt);
  await assert.rejects(f.lifecycle.registerGuild(f.scope.guildId, f.model), /removal is still in progress/);
  assert.deepEqual(await f.lifecycle.registerGuild(f.scope.guildId, f.model, { resumeRemoval: true }), f.scope);
  const firstCalls = { ...f.calls };
  const missingOwner = new RemovalService(bot, f.scope, f.authority, { community: f.owners.community! });
  await assert.rejects(missingOwner.runCleanup(), /cleanup owner is unavailable/);
  f.controls.pending = false;
  assert.equal(await f.removal.runCleanup(), true);
  assert.deepEqual({ community: f.calls.community, intake: f.calls.intake, jobs: f.calls.jobs },
    { community: firstCalls.community, intake: firstCalls.intake, jobs: firstCalls.jobs });
  const fresh = await f.lifecycle.registerGuild(f.scope.guildId, f.model);
  assert.notEqual(fresh.installationId, f.scope.installationId);
  const current = await bot.em.fork().findOneOrFail(GuildInstallation, { id: fresh.installationId });
  assert.equal(current.generation, before.generation + 1);
  assert.equal(await bot.em.fork().count(CapabilityGrant, fresh), 0);
  assert.equal((await f.authority.evaluateStaffRequest(f.caller(), { capability: 'guild.configure' })).allowed, false);
  await assert.rejects(f.authority.bootstrapOwner(f.caller()), /Installation is unavailable/);
  assert.equal(await f.conversation.receiveInput(f.message()), 'ignored');
  assert.equal(await bot.em.fork().count(GuildInstallation, { guildId: f.scope.guildId, state: 'active' }), 1);
  assert.equal((await f.installation()).state, 'removed');
});

test('the session ownership lock rejects a duplicate bot, permits other guilds and releases on stop', async () => {
  const guildId = '930000000000000099';
  let lost = 0;
  const first = createBotOwnership(() => bot, guildId, () => { lost++; });
  const duplicate = createBotOwnership(() => bot, guildId, () => { lost++; });
  const unrelated = createBotOwnership(() => bot, '930000000000000098', () => { lost++; });
  const successor = createBotOwnership(() => bot, guildId, () => { lost++; });
  const signal = new AbortController().signal;
  try {
    await first.start(signal);
    await assert.rejects(duplicate.start(signal), /Bot ownership unavailable/);
    await unrelated.start(signal);
    await duplicate.stop();
    await first.stop();
    await successor.start(signal);
    assert.equal(lost, 0);
  } finally { await Promise.allSettled([first.stop(), duplicate.stop(), unrelated.stop(), successor.stop()]); }
});
