/** Real PostgreSQL locks and rollback verify Administration foundations without issuing Discord effects. */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { createEntitySchemaSql } from '../../src/platform/db/schema-constraints.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { GuildSafetyState } from '../../src/contexts/administration/entities/guild-safety-state.entity.js';
import { CapabilityGrant } from '../../src/contexts/administration/entities/capability-grant.entity.js';
import { AuthorityService, type AdministrationInvalidator } from '../../src/contexts/administration/authority.service.js';
import { SafetyService } from '../../src/contexts/administration/safety.service.js';
import type { AdministrationFactReader, CurrentNativeFacts, TrustedCallerContext } from '../../src/contexts/administration/contracts.js';

let database: ReturnType<typeof temporaryPostgres>;
let orm: MikroORM;
let serial = 0;
const ownerId = '900000000000000001', staffId = '900000000000000002';

beforeAll(async () => {
  database = temporaryPostgres();
  orm = new MikroORM({ ...entityOrmConfig(), ...database.options });
  await orm.connect();
  database.applySchema(await createEntitySchemaSql(orm));
  await orm.em.fork().execute('create table administration_test_invalidation (installation_id uuid, kind text, revision int)');
}, 60_000);
afterAll(async () => { try { await orm?.close(true); } finally { database?.close(); } }, 30_000);

/** Each scenario owns a distinct installation; the fact adapter is the only mocked external boundary. */
async function scenario() {
  serial++;
  const guildId = String(910000000000000000n + BigInt(serial)), now = new Date();
  const installation = new GuildInstallation({ guildId, generation: 0, registeredAt: now, featureAdmission: { community: 'enabled', moderation: 'disabled' } });
  installation.recordAvailability('available', now);
  const scope = { installationId: installation.id, guildId };
  const gate = new GuildSafetyState({ ...scope, changedAt: now, changedBy: { kind: 'system', operation: 'fixture' } });
  await orm.em.fork().persist([installation, gate]).flush();
  let currentOwner = ownerId, actorPermissions = '8', failInvalidation = false;
  let changeFacts: ((facts: CurrentNativeFacts) => CurrentNativeFacts) | undefined;
  const facts: AdministrationFactReader = { /** Supply deterministic native authority facts; no real Discord permissions are consulted. */ async readFacts(caller, operation) {
    assert.equal(orm.em.isInTransaction(), false, 'No external read may run while a transaction is active');
    const observation: CurrentNativeFacts = { guildId: caller.guildId, actorId: caller.actorId, sourceRequestId: caller.sourceRequestId,
      operation, observedAt: new Date(), complete: true, ownerId: currentOwner, actorIsMember: true,
      actorPermissions, botPermissions: '8', ...(operation.targetUserId ? { target: { userId: operation.targetUserId,
        isMember: true, isGuildOwner: operation.targetUserId === currentOwner, isSelf: false, actorAboveTarget: true, botAboveTarget: true } } : {}) };
    return changeFacts ? changeFacts(observation) : observation;
  } };
  /** Apply the fixture owner invalidation under its normal transaction and lock order. */
  const invalidate: AdministrationInvalidator = async (em, event) => {
    assert.equal(em.isInTransaction(), true);
    await em.execute('insert into administration_test_invalidation values (?, ?, ?)', [event.installationId, event.kind, event.safetyRevision]);
    if (failInvalidation) throw new Error('owner_invalidation_failed');
  };
  const authority = new AuthorityService(orm, facts, invalidate), safety = new SafetyService(orm, authority, invalidate);
  const owner: TrustedCallerContext = { ...scope, actorId: ownerId, sourceRequestId: `owner:${serial}` };
  const staff: TrustedCallerContext = { ...scope, actorId: staffId, sourceRequestId: `staff:${serial}` };
  return { scope, authority, safety, owner, staff, facts, invalidate,
    /** Change the native owner fixture so the next authorization check sees the new owner. */
    setOwner(value: string) { currentOwner = value; }, /** Change native permission fixtures before the next fresh authorization check. */ setPermissions(value: string) { actorPermissions = value; },
    /** Arm the fixture failure used to prove transaction rollback during invalidation or cleanup. */
    failCleanup() { failInvalidation = true; }, /** Change the next native-fact snapshot to exercise an authorization rejection. */ alterFacts(value: typeof changeFacts) { changeFacts = value; } };
}

/** Issue a named grant through actual owner authorization instead of constructing an entity in tests. */
async function issue(f: Awaited<ReturnType<typeof scenario>>, capability = 'guild.pause', restrictions: { channelIds: string[]; targetUserIds: string[] } = { channelIds: [], targetUserIds: [] }) {
  return f.authority.grantCapability(f.owner, { granteeUserId: staffId, capability, scope: restrictions, sourceOperationKey: capability, expiresAt: null });
}

test('concurrent owner bootstrap is idempotent and enables no new feature or custodian workflow', async () => {
  const f = await scenario();
  const views = await Promise.all([f.authority.bootstrapOwner(f.owner), f.authority.bootstrapOwner(f.owner)]);
  assert.equal(views[0]!.grantId, views[1]!.grantId);
  assert.equal(await orm.em.fork().count(CapabilityGrant, f.scope), 1);
  assert.equal(views[0]!.capability, 'administration.manage');
  const installed = await orm.em.fork().findOneOrFail(GuildInstallation, { id: f.scope.installationId });
  assert.equal(installed.featureAdmission.moderation, 'disabled');
});

test('owner bootstrap rejects actor/native mismatch, non-owner administrator and wrong installation scope', async () => {
  const f = await scenario();
  await assert.rejects(f.authority.bootstrapOwner(f.staff), /current_owner_required/);
  f.alterFacts(facts => ({ ...facts, actorId: staffId }));
  await assert.rejects(f.authority.bootstrapOwner(f.owner), /native_facts_mismatch/);
  f.alterFacts(undefined);
  await assert.rejects(f.authority.bootstrapOwner({ ...f.owner, guildId: '999' }), /unavailable/);
  assert.equal(await orm.em.fork().count(CapabilityGrant, f.scope), 0);
});

test('native Administrator alone cannot acquire an application grant or delegate grants', async () => {
  const f = await scenario();
  assert.deepEqual(await f.authority.evaluateStaffRequest(f.staff, { capability: 'guild.pause' }), { allowed: false, reason: 'application_grant_required' });
  await f.authority.bootstrapOwner(f.owner);
  await assert.rejects(f.authority.grantCapability(f.staff, { granteeUserId: staffId, capability: 'guild.pause', scope: { channelIds: [], targetUserIds: [] }, sourceOperationKey: 'forged', expiresAt: null }), /current_owner_required/);
});

test('concurrent grant replay creates one immutable record and rejects changed replay payload', async () => {
  const f = await scenario(); await f.authority.bootstrapOwner(f.owner);
  const views = await Promise.all([issue(f), issue(f)]);
  assert.equal(views[0]!.grantId, views[1]!.grantId);
  await assert.rejects(issue(f, 'guild.pause', { channelIds: ['999'], targetUserIds: [] }), /replay payload mismatch/);
  assert.equal(await orm.em.fork().count(CapabilityGrant, f.scope), 2);
});

test('scope, expiry and fresh native permission independently restrict a valid application grant', async () => {
  const f = await scenario(); await f.authority.bootstrapOwner(f.owner);
  await issue(f, 'moderation.ban', { channelIds: ['200'], targetUserIds: ['300'] });
  const operation = { capability: 'moderation.ban', channelId: '200', targetUserId: '300' } as const;
  assert.equal((await f.authority.evaluateStaffRequest(f.staff, operation)).allowed, true);
  assert.equal((await f.authority.evaluateStaffRequest(f.staff, { ...operation, targetUserId: '301' })).allowed, false);
  f.setPermissions('0');
  assert.equal((await f.authority.evaluateStaffRequest(f.staff, operation)).allowed, false);
  f.setPermissions('8');
  const expiring = new CapabilityGrant({ ...f.scope, grantee: { kind: 'user', userId: staffId }, grantor: { kind: 'user', userId: ownerId },
    capability: 'guild.pause', scope: { channelIds: [], targetUserIds: [] }, sourceRequestId: 'expired', sourceOperationKey: 'expired',
    grantedAt: new Date(Date.now() - 20_000), expiresAt: new Date(Date.now() - 10_000) });
  await orm.em.fork().persist(expiring).flush();
  assert.equal((await f.authority.evaluateStaffRequest(f.staff, { capability: 'guild.pause' })).allowed, false);
});

test('ownership transfer removes the former owner baseline authority without rewriting grants', async () => {
  const f = await scenario(); await f.authority.bootstrapOwner(f.owner);
  f.setOwner(staffId);
  assert.equal((await f.authority.evaluateStaffRequest(f.owner, { capability: 'guild.pause' })).allowed, false);
  await assert.rejects(issue(f), /current_owner_required/);
  await f.authority.bootstrapOwner(f.staff);
  assert.equal((await f.authority.evaluateStaffRequest(f.staff, { capability: 'guild.pause' })).allowed, true);
});

test('competing grant revisions commit only one revocation and preserve idempotent matching replay', async () => {
  const f = await scenario(); await f.authority.bootstrapOwner(f.owner); const grant = await issue(f);
  const input = { grantId: grant.grantId, expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'first' };
  const outcomes = await Promise.allSettled([f.authority.revokeGrant(f.owner, input), f.authority.revokeGrant(f.owner, { ...input, reasonCode: 'second' })]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  const row = await orm.em.fork().findOneOrFail(CapabilityGrant, { id: grant.grantId });
  assert.equal(row.authorityRevision, 1); assert.equal(row.rowRevision, 2);
  const replay = await f.authority.revokeGrant(f.owner, { ...input, reasonCode: row.revocationReason! });
  assert.equal(replay.revoked, true);
  assert.equal((await f.authority.evaluateStaffRequest(f.staff, { capability: 'guild.pause' })).allowed, false);
  const safety = await orm.em.fork().findOneOrFail(GuildSafetyState, f.scope); assert.equal(safety.safetyRevision, 1);
  const events = await orm.em.fork().execute<unknown[]>('select * from administration_test_invalidation where installation_id=?', [f.scope.installationId]);
  assert.equal(events.length, 1);
});

test('revocation rolls back grant, safety fence and invalidation together if an owner fails cleanup', async () => {
  const f = await scenario(); await f.authority.bootstrapOwner(f.owner); const grant = await issue(f); f.failCleanup();
  await assert.rejects(f.authority.revokeGrant(f.owner, { grantId: grant.grantId, expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'revoke' }), /owner_invalidation_failed/);
  assert.equal((await orm.em.fork().findOneOrFail(CapabilityGrant, { id: grant.grantId })).revokedAt, null);
  assert.equal((await orm.em.fork().findOneOrFail(GuildSafetyState, f.scope)).safetyRevision, 0);
  assert.equal((await orm.em.fork().execute<unknown[]>('select * from administration_test_invalidation where installation_id=?', [f.scope.installationId])).length, 0);
});

test('pause and resume advance separate fences; stale resume cannot override a new pause', async () => {
  const f = await scenario(); await f.authority.bootstrapOwner(f.owner);
  const original = await f.authority.evaluateStaffRequest(f.owner, { capability: 'guild.pause' }); assert.ok(original.allowed);
  const paused = await f.safety.pauseGuild(f.owner, { expectedSafetyRevision: 0, reasonCode: 'operator_pause' });
  assert.deepEqual(paused, { paused: true, safetyRevision: 1, reasonCode: 'operator_pause' });
  await assert.rejects(f.safety.resumeGuild(f.owner, { expectedSafetyRevision: 0 }), /Stale safety revision/);
  const resumed = await f.safety.resumeGuild(f.owner, { expectedSafetyRevision: 1 });
  assert.deepEqual(resumed, { paused: false, safetyRevision: 2, reasonCode: null });
  const facts = await f.authority.readCurrentFacts(f.owner, original.authority.operation);
  assert.equal(await orm.em.fork().transactional(em => f.authority.validateGrantRevision(em, original.authority, facts)), false);
});

test('pause shares the installation gate with a concurrent admission claim', async () => {
  const f = await scenario(); await f.authority.bootstrapOwner(f.owner);
  let release!: () => void, locked!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const earlierClaim = orm.em.fork().transactional(async em => {
    const gate = await f.safety.lockAndReadGate(em, f.scope); assert.equal(gate?.paused, false);
    locked(); await hold; return gate!.safetyRevision;
  });
  await acquired;
  let pauseFinished = false;
  const pause = f.safety.pauseGuild(f.owner, { expectedSafetyRevision: 0, reasonCode: 'race' }).then(value => { pauseFinished = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(pauseFinished, false);
  release();
  assert.equal(await earlierClaim, 0);
  assert.equal((await pause).safetyRevision, 1);
  const after = await orm.em.fork().transactional(em => f.safety.lockAndReadGate(em, f.scope));
  assert.equal(after?.paused, true);
  assert.equal(after?.safetyRevision, 1);
});

test('stale native observations and nested external reads fail closed; required invalidators cannot be omitted', async () => {
  const f = await scenario(); await f.authority.bootstrapOwner(f.owner);
  f.alterFacts(facts => ({ ...facts, observedAt: new Date(Date.now() - 10_000) }));
  assert.equal((await f.authority.evaluateStaffRequest(f.owner, { capability: 'guild.pause' })).allowed, false);
  await orm.em.fork().transactional(async () => {
    await assert.rejects(f.authority.readCurrentFacts(f.owner, { capability: 'guild.pause' }), /outside transactions/);
  });
  assert.throws(() => new AuthorityService(orm, f.facts, undefined as unknown as AdministrationInvalidator), /required/);
  assert.throws(() => new SafetyService(orm, f.authority, undefined as unknown as AdministrationInvalidator), /required/);
});

test('missing grant scope and failed pause invalidation cannot mutate another installation', async () => {
  const f = await scenario(), other = await scenario();
  await f.authority.bootstrapOwner(f.owner); await other.authority.bootstrapOwner(other.owner);
  const grant = await issue(other);
  await assert.rejects(f.authority.revokeGrant(f.owner, { grantId: grant.grantId, expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'cross_scope' }), /not found/);
  f.failCleanup();
  await assert.rejects(f.safety.pauseGuild(f.owner, { expectedSafetyRevision: 0, reasonCode: 'rollback' }), /owner_invalidation_failed/);
  assert.equal((await orm.em.fork().findOneOrFail(GuildSafetyState, f.scope)).paused, false);
});
