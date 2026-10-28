/** Real PostgreSQL claims verify staff authority, one-shot dispatch and cross-installation uncertainty fencing. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { AuthorityService } from '../../src/contexts/administration/authority.service.js';
import { SafetyService } from '../../src/contexts/administration/safety.service.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { StaffModerationService } from '../../src/contexts/moderation/staff-moderation.service.js';
import { ActionExecutionService } from '../../src/contexts/moderation/action-execution.service.js';
import { ModerationAction } from '../../src/contexts/moderation/entities/moderation-action.entity.js';
import { ActionAttempt } from '../../src/contexts/moderation/entities/action-attempt.entity.js';
import { TargetExecutionState } from '../../src/contexts/moderation/entities/target-execution-state.entity.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { AuditRecorder } from '../../src/platform/audit/audit.recorder.js';
import { AuditEntry } from '../../src/platform/audit/entities/audit-entry.entity.js';
import type { AdministrationFactReader } from '../../src/contexts/administration/contracts.js';
import type { DiscordModerationTransport, DiscordModerationOutcome, DiscordModerationRequest, DiscordModerationReconciliation } from '../../src/discord/moderation-transport.js';

let database: ReturnType<typeof temporaryPostgres>, orm: MikroORM, inspector: MikroORM, serial = 0;
const ownerId = '970000000000000001', staffId = '970000000000000002', targetId = '970000000000000003';
const signal = new AbortController().signal;
beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'effects-bot', workerDatabasePassword: 'effects-worker' });
  orm = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false });
  inspector = new MikroORM({ ...entityOrmConfig(), ...database.options, ensureDatabase: false });
  await Promise.all([orm.connect(), inspector.connect()]);
}, 60_000);
afterAll(async () => { try { await Promise.all([orm?.close(true), inspector?.close(true)]); } finally { database?.close(); } }, 30_000);

/** Checkpoints choose race order without timing sleeps. */
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
/** Time only bounds a broken test, never decides the transaction winner. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error('Effect checkpoint timeout')), 4000); })]); }
  finally { clearTimeout(timer); }
}

/** Only Discord reads/effects are fake; installation, authorization, grants, audit and execution use production services. */
async function scenario(guildId = String(970000000000000100n + BigInt(++serial))) {
  const lifecycle = new GuildLifecycleService(orm), scope = await lifecycle.registerGuild(guildId, 'test-model');
  const native = { actorPermissions: '8', targetMember: true, hierarchy: true, complete: true };
  let requestNumber = 0;
  /** Bind a fixture user to this installation with independent request provenance. */
  const caller = (actorId = staffId) => ({ ...scope, actorId, sourceRequestId: `staff:${serial}:${++requestNumber}` });
  const facts: AdministrationFactReader = { /** Supply deterministic native authority facts; no real Discord permissions are consulted. */ async readFacts(actor, operation) {
    assert.equal(orm.em.isInTransaction(), false);
    return { guildId, actorId: actor.actorId, sourceRequestId: actor.sourceRequestId, operation, observedAt: new Date(),
      complete: native.complete, ownerId, actorIsMember: true, actorPermissions: actor.actorId === ownerId ? '8' : native.actorPermissions,
      botPermissions: '8', ...(operation.targetUserId ? { target: { userId: operation.targetUserId,
        isMember: native.targetMember, isGuildOwner: false, isSelf: false, actorAboveTarget: native.hierarchy, botAboveTarget: native.hierarchy } } : {}) };
  } };
  const authority = new AuthorityService(orm, facts, async () => {}), safety = new SafetyService(orm, authority, async () => {});
  await authority.bootstrapOwner(caller(ownerId));
  const grants = {} as Record<'ban' | 'unban' | 'kick', Awaited<ReturnType<AuthorityService['grantCapability']>>>;
  for (const kind of ['ban', 'unban', 'kick'] as const) grants[kind] = await authority.grantCapability(caller(ownerId), {
    granteeUserId: staffId, capability: `moderation.${kind}`, scope: { channelIds: [], targetUserIds: [targetId] }, sourceOperationKey: kind, expiresAt: null });
  const staff = new StaffModerationService(orm, scope, authority, safety, lifecycle);
  const controls = { permitted: true, complete: true, outcome: { classification: 'confirmed', code: 'applied', httpStatus: 204 } as DiscordModerationOutcome,
    evidence: null as DiscordModerationReconciliation | null, prepareHold: null as ReturnType<typeof deferred<void>> | null,
    executeHold: null as ReturnType<typeof deferred<void>> | null, enteredPrepare: deferred<void>(), enteredExecute: deferred<void>() };
  const calls: DiscordModerationRequest[] = [];
  const preparationIds: string[] = [];
  const transport: Pick<DiscordModerationTransport, 'prepare' | 'execute' | 'reconcile'> = {
    /** Supply deterministic effect preparation and fresh authority facts before dispatch. */
    async prepare(request) {
      preparationIds.push(request.actionId);
      assert.equal(orm.em.isInTransaction(), false); controls.enteredPrepare.resolve(); if (controls.prepareHold) await bounded(controls.prepareHold.promise);
      return { actionId: request.actionId, guildId, targetUserId: request.targetUserId, kind: request.operation.kind,
        complete: controls.complete, permitted: controls.permitted, observedAt: new Date(), channelId: null };
    },
    /** Capture the exact requested moderation effect without contacting Discord. */
    async execute(request) {
      assert.equal(orm.em.isInTransaction(), false);
      const action = await orm.em.fork().findOneOrFail(ModerationAction, { ...scope, id: request.actionId });
      const attempt = await orm.em.fork().findOneOrFail(ActionAttempt, { ...scope, id: request.attemptId });
      assert.equal(action.state, 'DISPATCHED'); assert.ok(attempt.sentAt);
      assert.equal((await orm.em.fork().findOneOrFail(TargetExecutionState, { guildId, targetUserId: targetId })).unresolvedActionId, action.id);
      calls.push(request); controls.enteredExecute.resolve(); if (controls.executeHold) await bounded(controls.executeHold.promise);
      return controls.outcome;
    },
    /** Return the fixture's attributable remote outcome without repeating the effect. */
    async reconcile() { assert.equal(orm.em.isInTransaction(), false); return controls.evidence; },
  };
  /** Construct the action executor with this fixture transport and authority dependencies. */
  const execution = (audit?: AuditRecorder) => new ActionExecutionService(orm, scope, authority, safety, lifecycle, transport, audit);
  return { scope, lifecycle, caller, authority, safety, staff, native, controls, calls, preparationIds, grants, execution,
    request: () => staff.requestBan(caller(), { targetUserId: targetId, reason: 'Explicit staff request' }),
    action: (id: string) => orm.em.fork().findOneOrFail(ModerationAction, { ...scope, id }) };
}

test('staff requests need exact native/app target authority, deduplicate immutable intent, and default history deletion to zero', async () => {
  const f = await scenario(), caller = f.caller(), input = { targetUserId: targetId, reason: 'Explicit reason' };
  const admitted = await Promise.all([f.staff.requestBan(caller, input), f.staff.requestBan(caller, input)]);
  assert.equal(admitted[0]!.actionId, admitted[1]!.actionId);
  const action = await f.action(admitted[0]!.actionId);
  assert.equal(action.operationPayload?.kind, 'ban'); assert.equal((action.operationPayload as { deleteMessageSeconds: number }).deleteMessageSeconds, 0);
  assert.equal((await orm.em.fork().findOneOrFail(GuildInstallation, { id: f.scope.installationId })).featureAdmission.moderation, 'disabled');
  await assert.rejects(f.staff.requestBan(caller, { ...input, reason: 'changed' }), /replay payload mismatch/);
  await assert.rejects(f.staff.requestBan(f.caller(), { ...input, actorId: ownerId }), /Unknown/);
  await assert.rejects(f.staff.requestBan(f.caller(), { ...input, targetUserId: '970000000000000004' }), /application_grant_required/);
  await assert.rejects(f.staff.requestBan(f.caller(ownerId), input), /application_grant_required/);
  f.native.actorPermissions = '0'; await assert.rejects(f.staff.requestBan(f.caller(), input), /native_permission_denied/);
  f.native.actorPermissions = '4'; await assert.rejects(f.staff.requestUnban(f.caller(), input), /native_administrator_required/);
  f.native.targetMember = false; await assert.doesNotReject(f.staff.requestBan(f.caller(), input));
  assert.equal(f.calls.length, 0);
});

test('staff kicks bind exact capability, member, hierarchy and immutable payload without a history-deletion option', async () => {
  const f = await scenario(), caller = f.caller(), input = { targetUserId: targetId, reason: 'Explicit kick reason' };
  const admitted = await Promise.all([f.staff.requestKick(caller, input), f.staff.requestKick(caller, input)]);
  assert.equal(admitted[0]!.actionId, admitted[1]!.actionId);
  const action = await f.action(admitted[0]!.actionId);
  assert.equal(action.kind, 'kick'); assert.equal(action.grantBinding?.grantId, f.grants.kick.grantId);
  assert.deepEqual(action.operationPayload, { schemaVersion: 1, kind: 'kick', reason: input.reason });
  assert.equal((await f.staff.readActionStatus(f.caller(), action.id)).kind, 'kick');
  await assert.rejects(f.staff.requestKick(caller, { ...input, reason: 'changed' }), /replay payload mismatch/);
  await assert.rejects(f.staff.requestBan(caller, input), /replay payload mismatch/);
  await assert.rejects(f.staff.requestKick(f.caller(), { ...input, deleteMessageSeconds: 0 }), /Unknown/);
  await assert.rejects(f.staff.requestKick(f.caller(), { ...input, actorId: ownerId }), /Unknown/);
  await assert.rejects(f.staff.requestKick(f.caller(), { ...input, targetUserId: '970000000000000004' }), /application_grant_required/);
  f.native.actorPermissions = '4'; await assert.rejects(f.staff.requestKick(f.caller(), input), /native_permission_denied/);
  f.native.actorPermissions = '2'; f.native.targetMember = false;
  await assert.rejects(f.staff.requestKick(f.caller(), input), /target_not_member/);
  f.native.targetMember = true; f.native.hierarchy = false;
  await assert.rejects(f.staff.requestKick(f.caller(), input), /target_hierarchy_denied/);
  f.native.hierarchy = true;
  await f.authority.revokeGrant(f.caller(ownerId), { grantId: f.grants.kick.grantId,
    expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'stop' });
  await assert.rejects(f.staff.requestKick(f.caller(), input), /application_grant_required/, 'The remaining ban grant cannot admit a kick');
  assert.equal(f.calls.length, 0);
});

test.each(['member_left', 'hierarchy_changed', 'grant_revoked'] as const)('kick dispatch cancels when %s after admission', async change => {
  const f = await scenario(), accepted = await f.staff.requestKick(f.caller(), { targetUserId: targetId, reason: 'Explicit kick' });
  if (change === 'member_left') f.native.targetMember = false;
  else if (change === 'hierarchy_changed') f.native.hierarchy = false;
  else await f.authority.revokeGrant(f.caller(ownerId), { grantId: f.grants.kick.grantId,
    expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'stop' });
  assert.equal((await f.execution().dispatch(accepted.actionId, signal))?.state, 'CANCELED');
  assert.equal(f.calls.length, 0); assert.equal(await orm.em.fork().count(ActionAttempt, f.scope), 0);
});

test('uncertain kick blocks a later ban, retains one attempt across recovery, and resolves only from exact evidence', async () => {
  const f = await scenario(), accepted = await f.staff.requestKick(f.caller(), { targetUserId: targetId, reason: 'Explicit kick' });
  f.controls.outcome = { classification: 'unknown', code: 'timeout' };
  assert.equal((await f.execution().dispatch(accepted.actionId, signal))?.state, 'UNKNOWN');
  const attempt = await orm.em.fork().findOneOrFail(ActionAttempt, { ...f.scope, actionId: accepted.actionId });
  assert.equal(attempt.endpoint, 'remove_guild_member'); assert.equal(attempt.requestNonce, null);
  assert.equal(f.calls[0]!.operation.kind, 'kick');
  f.native.targetMember = false;
  const ban = await f.request();
  assert.equal((await f.execution().dispatch(ban.actionId, signal))?.state, 'READY');
  await f.execution().recoverDueActions(signal);
  assert.equal((await f.action(accepted.actionId)).state, 'UNKNOWN'); assert.equal(f.calls.length, 1);
  assert.equal(await orm.em.fork().count(ActionAttempt, { ...f.scope, actionId: accepted.actionId }), 1);
  f.controls.evidence = { outcome: { classification: 'confirmed', code: 'exact_kick_audit', discordAuditEntryId: '970000000000000901' },
    source: 'discord_audit_log', reference: '970000000000000901' };
  assert.equal((await f.execution().reconcile(accepted.actionId, signal))?.state, 'CONFIRMED');
  assert.equal((await f.execution().dispatch(accepted.actionId, signal))?.state, 'CONFIRMED'); assert.equal(f.calls.length, 1);
  const status = await f.staff.readActionStatus(f.caller(), accepted.actionId);
  assert.equal(status.kind, 'kick'); assert.equal(status.state, 'CONFIRMED');
  assert.ok(!JSON.stringify(status).includes('Explicit kick'));
  const caller = f.caller(), operation = { capability: 'moderation.kick' as const, targetUserId: targetId };
  const facts = await f.authority.readCurrentFacts(caller, operation);
  await orm.em.fork().transactional(async em => {
    const statusAuthority = await f.authority.authorizeInTransaction(em, caller, operation, facts, 'status');
    assert.equal(statusAuthority.allowed, true);
    if (statusAuthority.allowed) assert.equal(await f.authority.validateGrantRevision(em, statusAuthority.authority, facts), false);
  });
  await assert.rejects(f.staff.readActionStatus(f.caller(ownerId), accepted.actionId), /application_grant_required/);
  f.native.actorPermissions = '4'; await assert.rejects(f.staff.readActionStatus(f.caller(), accepted.actionId), /native_permission_denied/);
  f.native.actorPermissions = '8';
  f.controls.outcome = { classification: 'confirmed', code: 'banned', httpStatus: 204 };
  assert.equal((await f.execution().dispatch(ban.actionId, signal))?.state, 'CONFIRMED'); assert.equal(f.calls.length, 2);
});

test('kick recovery commits one confirmed attempt and records no invented Discord action ID', async () => {
  const f = await scenario(), accepted = await f.staff.requestKick(f.caller(), { targetUserId: targetId, reason: 'Explicit kick' });
  assert.equal((await f.execution().recoverDueActions(signal)).outcomes[0]?.state, 'CONFIRMED');
  await f.execution().recoverDueActions(signal); assert.equal(f.calls.length, 1);
  const action = await f.action(accepted.actionId), attempt = await orm.em.fork().findOneOrFail(ActionAttempt, { ...f.scope, actionId: action.id });
  assert.equal(attempt.endpoint, 'remove_guild_member'); assert.equal(attempt.httpStatus, 204);
  assert.equal(attempt.discordAuditEntryId, null); assert.equal(attempt.discordMessageId, null);
});

test('competing executors commit one attempt and one effect; confirmed completion releases the shared target', async () => {
  const f = await scenario(), accepted = await f.request();
  f.controls.executeHold = deferred<void>();
  const first = f.execution().dispatch(accepted.actionId, signal);
  try {
    await bounded(f.controls.enteredExecute.promise);
    assert.equal((await f.execution().dispatch(accepted.actionId, signal))?.state, 'DISPATCHED');
    f.controls.executeHold.resolve(); assert.equal((await first)?.state, 'CONFIRMED');
  } finally { f.controls.executeHold.resolve(); await first; }
  assert.equal(f.calls.length, 1); assert.equal(await orm.em.fork().count(ActionAttempt, { ...f.scope, actionId: accepted.actionId }), 1);
  assert.equal((await orm.em.fork().findOneOrFail(TargetExecutionState, { guildId: f.scope.guildId, targetUserId: targetId })).unresolvedActionId, null);
  assert.equal((await f.execution().dispatch(accepted.actionId, signal))?.state, 'CONFIRMED'); assert.equal(f.calls.length, 1);
});

test.each(['pause', 'revoke', 'native'] as const)('%s committed while remote preparation waits prevents the dispatch claim', async change => {
  const f = await scenario(), accepted = await f.request(); f.controls.prepareHold = deferred<void>();
  const dispatching = f.execution().dispatch(accepted.actionId, signal);
  try {
    await bounded(f.controls.enteredPrepare.promise);
    if (change === 'pause') await f.safety.pauseGuild(f.caller(ownerId), { expectedSafetyRevision: 0, reasonCode: 'stop' });
    else if (change === 'revoke') await f.authority.revokeGrant(f.caller(ownerId), { grantId: f.grants.ban.grantId,
      expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'stop' });
    else f.controls.permitted = false;
    f.controls.prepareHold.resolve(); assert.equal((await dispatching)?.state, 'CANCELED');
  } finally { f.controls.prepareHold.resolve(); await dispatching; }
  assert.equal(f.calls.length, 0); assert.equal(await orm.em.fork().count(ActionAttempt, f.scope), 0);
});

test('unknown ban blocks an explicit unban until exact attribution resolves the old attempt without resending', async () => {
  const f = await scenario(), ban = await f.request(); f.controls.outcome = { classification: 'unknown', code: 'timeout' };
  assert.equal((await f.execution().dispatch(ban.actionId, signal))?.state, 'UNKNOWN');
  const unban = await f.staff.requestUnban(f.caller(), { targetUserId: targetId, reason: 'Explicit administrator reversal' });
  assert.equal((await f.execution().dispatch(unban.actionId, signal))?.state, 'READY');
  assert.equal((await f.execution().reconcile(ban.actionId, signal))?.state, 'UNKNOWN'); assert.equal(f.calls.length, 1);
  f.controls.evidence = { outcome: { classification: 'confirmed', code: 'exact_audit', discordAuditEntryId: '970000000000000900' },
    source: 'discord_audit_log', reference: '970000000000000900' };
  assert.equal((await f.execution().reconcile(ban.actionId, signal))?.state, 'CONFIRMED');
  f.controls.outcome = { classification: 'confirmed', code: 'unbanned', httpStatus: 204 };
  assert.equal((await f.execution().dispatch(unban.actionId, signal))?.state, 'CONFIRMED'); assert.equal(f.calls.length, 2);
  assert.equal((await f.action(unban.actionId)).adminUnbanRequest?.actorUserId, staffId);
});

test('definitive failure releases the gate but the same action is never retried', async () => {
  const f = await scenario(), accepted = await f.request(); f.controls.outcome = { classification: 'definitive_failure', code: 'denied', httpStatus: 403 };
  assert.equal((await f.execution().dispatch(accepted.actionId, signal))?.state, 'FAILED');
  await f.execution().recoverDueActions(signal); assert.equal(f.calls.length, 1);
  assert.equal((await orm.em.fork().findOneOrFail(TargetExecutionState, { guildId: f.scope.guildId, targetUserId: targetId })).unresolvedActionId, null);
});

test('audit failure before claim commit rolls back attempt and target ownership without sending', async () => {
  const f = await scenario(), accepted = await f.request(), audit = new AuditRecorder();
  audit.recordTransition = async () => { throw new Error('audit_unavailable'); };
  await assert.rejects(f.execution(audit).dispatch(accepted.actionId, signal), /audit_unavailable/);
  assert.equal((await f.action(accepted.actionId)).state, 'READY'); assert.equal(f.calls.length, 0);
  assert.equal(await orm.em.fork().count(ActionAttempt, f.scope), 0);
  assert.equal(await orm.em.fork().count(TargetExecutionState, { guildId: f.scope.guildId }), 0);
});

test('outcome storage failure retains the consumed attempt; lease expiry recovers as unknown without a second effect', async () => {
  const f = await scenario(), accepted = await f.request(), audit = new AuditRecorder(), original = audit.recordTransition.bind(audit);
  audit.recordTransition = async (em, input) => { if (input.outcome === 'succeeded') throw new Error('outcome_commit_failed'); return original(em, input); };
  await assert.rejects(f.execution(audit).dispatch(accepted.actionId, signal), /outcome_commit_failed/);
  assert.equal((await f.action(accepted.actionId)).state, 'DISPATCHED'); assert.equal(f.calls.length, 1);
  await inspector.em.fork().execute('update action_attempt set lease_until=now()-interval \'1 second\' where action_id=?', [accepted.actionId]);
  assert.equal((await f.execution().reconcile(accepted.actionId, signal))?.state, 'UNKNOWN');
  await f.execution().recoverDueActions(signal); assert.equal(f.calls.length, 1);
  assert.equal(await orm.em.fork().count(AuditEntry, { ...f.scope, outcome: 'succeeded', operation: 'moderation.execution' }), 0);
});

test('late confirmed truth after pause is recorded while new pre-pause actions are canceled', async () => {
  const f = await scenario(), accepted = await f.request(), pending = await f.request(); f.controls.executeHold = deferred<void>();
  const sending = f.execution().dispatch(accepted.actionId, signal);
  try {
    await bounded(f.controls.enteredExecute.promise); await f.safety.pauseGuild(f.caller(ownerId), { expectedSafetyRevision: 0, reasonCode: 'pause' });
    f.controls.executeHold.resolve(); assert.equal((await sending)?.state, 'CONFIRMED');
    assert.equal((await f.execution().dispatch(pending.actionId, signal))?.state, 'CANCELED');
  } finally { f.controls.executeHold.resolve(); await sending; }
  assert.equal(f.calls.length, 1);
});

test('an unresolved target from a previous installation still blocks the new installation', async () => {
  const f = await scenario(), accepted = await f.request(); f.controls.outcome = { classification: 'unknown', code: 'timeout' };
  await f.execution().dispatch(accepted.actionId, signal);
  // Simulate completed removal locally; the unresolved target is deliberately not erased by cleanup.
  await inspector.em.fork().execute("update guild_installation set state='removed', removal_started_at=now(), removed_at=now() where id=?", [f.scope.installationId]);
  const replacement = await scenario(f.scope.guildId), next = await replacement.request();
  assert.notEqual(f.scope.installationId, replacement.scope.installationId);
  assert.equal((await replacement.execution().dispatch(next.actionId, signal))?.state, 'READY');
  assert.equal(replacement.calls.length, 0);
});

test('shutdown and incomplete preparation leave no consumed attempt or effect', async () => {
  const f = await scenario(), accepted = await f.request(); f.controls.complete = false;
  assert.equal((await f.execution().dispatch(accepted.actionId, signal))?.state, 'READY');
  const stopped = new AbortController(); stopped.abort(); assert.equal(await f.execution().dispatch(accepted.actionId, stopped.signal), null);
  assert.equal(await orm.em.fork().count(ActionAttempt, f.scope), 0); assert.equal(f.calls.length, 0);
  assert.equal(await f.execution().dispatch(randomUUID(), signal), null);
});

test('bounded recovery rotates past unavailable actions and status remains exact-target authorized without content disclosure', async () => {
  const f = await scenario(); f.controls.complete = false;
  const admitted = await Promise.all(Array.from({ length: 21 }, () => f.request())), execution = f.execution();
  await execution.recoverDueActions(signal); assert.equal(f.preparationIds.length, 20);
  await execution.recoverDueActions(signal); assert.equal(new Set(f.preparationIds).size, 21); assert.equal(f.calls.length, 0);
  const status = await f.staff.readActionStatus(f.caller(), admitted[0]!.actionId);
  assert.equal(status.state, 'READY'); assert.ok(!JSON.stringify(status).includes('Explicit staff request'));
  await assert.rejects(f.staff.readActionStatus(f.caller(ownerId), admitted[0]!.actionId), /application_grant_required/);
  await assert.rejects(f.staff.readActionStatus({ ...f.caller(), installationId: randomUUID() }, admitted[0]!.actionId), /Installation mismatch/);
});
