/** Staged-schema integration verifies independent governance consent, current authority, one-time consumption and owner rollback without live Discord. */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { createEntitySchemaSql } from '../../src/platform/db/schema-constraints.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { GuildSafetyState } from '../../src/contexts/administration/entities/guild-safety-state.entity.js';
import { CapabilityGrant } from '../../src/contexts/administration/entities/capability-grant.entity.js';
import { ActionPlan } from '../../src/contexts/administration/entities/action-plan.entity.js';
import { PlanApproval } from '../../src/contexts/administration/entities/plan-approval.entity.js';
import { CustodianEnrollment } from '../../src/contexts/administration/entities/custodian-enrollment.entity.js';
import { AuthorityService } from '../../src/contexts/administration/authority.service.js';
import { GovernanceService, readGovernanceObservations } from '../../src/contexts/administration/governance.service.js';
import { ApprovedPlanHandlers } from '../../apps/bot/approved-plan.handlers.js';
import type { AdministrationFactReader, CurrentNativeFacts, TrustedCallerContext } from '../../src/contexts/administration/contracts.js';
import type { GovernanceOperation } from '../../src/contexts/administration/dto/governance.dto.js';

let database: ReturnType<typeof temporaryPostgres>, orm: MikroORM, serial = 0;
const ownerId = '810000000000000001', approverA = '810000000000000002', approverB = '810000000000000003', candidateId = '810000000000000004';
const policy = { enabled: true as const, revision: 1, minimumApprovals: 2, maximumPlanLifetimeMs: 3600_000, retentionDays: 7 };

beforeAll(async () => {
  database = temporaryPostgres();
  orm = new MikroORM({ ...entityOrmConfig({ includeStaged: true }), ...database.options });
  await orm.connect(); database.applySchema(await createEntitySchemaSql(orm));
}, 60_000);
afterAll(async () => { try { await orm?.close(true); } finally { database?.close(); } }, 30_000);

/** Seed opt-in custodians explicitly in a private staged schema; baseline owner commands still cannot issue this special capability. */
async function scenario() {
  const now = new Date(), guildId = String(820000000000000000n + BigInt(++serial));
  const installation = new GuildInstallation({ guildId, generation: 1, registeredAt: now, featureAdmission: {} });
  installation.recordAvailability('available', now);
  const scope = { installationId: installation.id, guildId };
  const safety = new GuildSafetyState({ ...scope, changedAt: now, changedBy: { kind: 'system', operation: 'fixture' } });
  const grants = [ownerId, approverA, approverB, candidateId].map(userId => new CapabilityGrant({ ...scope,
    grantee: { kind: 'user' as const, userId }, grantor: { kind: 'user' as const, userId: ownerId }, capability: 'governance.custodian',
    scope: { channelIds: [], targetUserIds: [] }, sourceRequestId: `seed:${userId}`, sourceOperationKey: 'custodian', grantedAt: now, expiresAt: null, createdAt: now }));
  await orm.em.fork().persist([installation, safety, ...grants]).flush();
  let deniedUser: string | undefined, stale = false, failInvalidation = false;
  const reader: AdministrationFactReader = { /** Simulate only Discord facts, retaining exact actor/request/operation bindings. */ async readFacts(caller, operation) {
    assert.equal(orm.em.isInTransaction(), false);
    return { guildId, actorId: caller.actorId, sourceRequestId: caller.sourceRequestId, operation,
      observedAt: new Date(Date.now() - (stale ? 10_000 : 0)), complete: true, ownerId, actorIsMember: caller.actorId !== deniedUser,
      actorPermissions: '8', botPermissions: '8' } satisfies CurrentNativeFacts;
  } };
  const authority = new AuthorityService(orm, reader, async () => { if (failInvalidation) throw new Error('fixture owner failure'); });
  const governance = new GovernanceService(orm, authority, policy), handler = new ApprovedPlanHandlers(orm, governance, authority);
  /** Bind each independently authenticated fixture caller to its own source request. */
  const caller = (actorId: string, sourceRequestId = `request:${serial}:${actorId}`): TrustedCallerContext => ({ ...scope, actorId, sourceRequestId });
  const owner = caller(ownerId); await authority.bootstrapOwner(owner);
  return { scope, authority, governance, handler, owner, caller, grants,
    /** Remove current membership at the next observation without rewriting old approval evidence. */ deny(userId: string) { deniedUser = userId; },
    /** Make observations stale to prove locked consumption fails closed. */ staleFacts() { stale = true; },
    /** Fail inside the existing owner invalidation boundary after grant mutation. */ failOwner() { failInvalidation = true; } };
}

/** Propose a bounded known-capability grant with a stable expiry for replay checks. */
async function proposal(f: Awaited<ReturnType<typeof scenario>>, operations: readonly GovernanceOperation[] = [
  { kind: 'grant_capability', granteeUserId: candidateId, capability: 'guild.pause', channelIds: [], targetUserIds: [], expiresAt: null },
]) {
  const input = { operations, sourceOperationKey: 'fixture-plan', expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const plan = await f.governance.proposePlan(f.owner, input);
  return { input, plan, reference: { planId: plan.planId, planHash: plan.planHash } };
}

/** Obtain the configured quorum from two different authenticated, eligible custodians. */
async function approve(f: Awaited<ReturnType<typeof scenario>>, reference: { planId: string; planHash: string }) {
  await f.governance.approvePlan(f.caller(approverA), reference);
  await f.governance.approvePlan(f.caller(approverB), reference);
}

test('proposal replay is immutable and current distinct approvals exclude requester and recipient', async () => {
  const f = await scenario(), { plan, input, reference } = await proposal(f);
  assert.equal((await f.governance.proposePlan(f.owner, input)).planId, plan.planId);
  await assert.rejects(f.governance.proposePlan(f.owner, { ...input, expiresAt: new Date(Date.now() + 60_000).toISOString() }), /replay payload/);
  await assert.rejects(f.governance.approvePlan(f.owner, reference), /cannot approve/);
  await assert.rejects(f.governance.approvePlan(f.caller(candidateId), reference), /cannot approve/);
  await f.governance.approvePlan(f.caller(approverA), reference);
  await f.governance.approvePlan(f.caller(approverA), reference);
  assert.equal(await orm.em.fork().count(PlanApproval, { ...f.scope, planId: plan.planId }), 1);
  await assert.rejects(f.handler.applyApprovedPlan(f.owner, reference), /Insufficient distinct/);
  await f.governance.approvePlan(f.caller(approverB), reference);
  const result = await f.handler.applyApprovedPlan(f.owner, reference);
  assert.equal(result.grants[0]?.capability, 'guild.pause');
  await assert.rejects(f.handler.applyApprovedPlan(f.owner, reference), /not pending/);
  assert.equal(await orm.em.fork().count(CapabilityGrant, { ...f.scope, capability: 'guild.pause' }), 1);
});

test('concurrent consumption commits exactly one operation and one plan reference', async () => {
  const f = await scenario(), { reference } = await proposal(f); await approve(f, reference);
  const outcomes = await Promise.allSettled([f.handler.applyApprovedPlan(f.owner, reference), f.handler.applyApprovedPlan(f.owner, reference)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await orm.em.fork().count(CapabilityGrant, { ...f.scope, capability: 'guild.pause' }), 1);
});

test('withdrawn approval, lost native membership, changed grant revisions and changed policy cannot satisfy old quorum', async () => {
  const f = await scenario(), { reference } = await proposal(f); await approve(f, reference);
  f.deny(approverA);
  await assert.rejects(f.handler.applyApprovedPlan(f.owner, reference), /Insufficient distinct/);
  const revised = new GovernanceService(orm, f.authority, { ...policy, revision: 2 });
  await assert.rejects(new ApprovedPlanHandlers(orm, revised, f.authority).applyApprovedPlan(f.owner, reference), /policy changed/);
  const other = await scenario(), p = await proposal(other); await approve(other, p.reference);
  await orm.em.fork().transactional(async em => {
    const approval = await em.findOneOrFail(PlanApproval, { ...other.scope, planId: p.plan.planId, approverId: approverA });
    approval.withdraw(new Date());
  });
  await assert.rejects(other.handler.applyApprovedPlan(other.owner, p.reference), /Insufficient distinct/);
  const third = await scenario(), q = await proposal(third); await approve(third, q.reference);
  await orm.em.fork().execute('update capability_grant set authority_revision=authority_revision+1, row_revision=row_revision+1 where id=?', [third.grants[1]!.id]);
  await assert.rejects(third.handler.applyApprovedPlan(third.owner, q.reference), /Insufficient distinct/);
});

test('tampered operation content, wrong hash and cross-installation references fail before mutation', async () => {
  const f = await scenario(), { reference } = await proposal(f); await approve(f, reference);
  await assert.rejects(f.handler.applyApprovedPlan(f.owner, { ...reference, planHash: 'a'.repeat(64) }), /not found/);
  const other = await scenario();
  await assert.rejects(other.handler.applyApprovedPlan(other.owner, reference), /not found/);
  await orm.em.fork().execute("update action_plan set operations=jsonb_set(operations, '{0,capability}', '\"guild.resume\"') where id=?", [reference.planId]);
  await assert.rejects(f.handler.applyApprovedPlan(f.owner, reference), /content changed/);
  assert.equal(await orm.em.fork().count(CapabilityGrant, { ...f.scope, capability: 'guild.resume' }), 0);
});

test('owner failure rolls back plan consumption, revoked grant and safety fence together', async () => {
  const f = await scenario();
  const grant = await f.authority.grantCapability(f.owner, { granteeUserId: candidateId, capability: 'guild.pause',
    scope: { channelIds: [], targetUserIds: [] }, sourceOperationKey: 'to-revoke', expiresAt: null });
  const { reference } = await proposal(f, [{ kind: 'revoke_capability', grantId: grant.grantId, expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'governed' }]);
  await approve(f, reference); f.failOwner();
  await assert.rejects(f.handler.applyApprovedPlan(f.owner, reference), /fixture owner failure/);
  assert.equal((await orm.em.fork().findOneOrFail(ActionPlan, reference.planId)).status, 'pending');
  assert.equal((await orm.em.fork().findOneOrFail(CapabilityGrant, grant.grantId)).revokedAt, null);
  assert.equal((await orm.em.fork().findOneOrFail(GuildSafetyState, f.scope)).safetyRevision, 0);
});

test('consumption rejects missing transaction and stale observations', async () => {
  const f = await scenario(), { reference } = await proposal(f); await approve(f, reference);
  const observations = await readGovernanceObservations(orm, f.authority, f.owner, reference);
  await assert.rejects(f.governance.consumeApproval(orm.em.fork(), f.owner, reference, observations), /owner transaction/);
  f.staleFacts();
  await assert.rejects(f.handler.applyApprovedPlan(f.owner, reference), /native_facts_stale/);
});

test('custodian enrollment requires independent candidate acceptance and consumes the exact plan atomically', async () => {
  const f = await scenario(), { reference } = await proposal(f, [{ kind: 'grant_capability', granteeUserId: candidateId,
    capability: 'governance.custodian', channelIds: [], targetUserIds: [], expiresAt: null }]);
  const request = { ...reference, candidateId };
  const invite = await f.governance.enrollCustodian(f.owner, { ...request, action: 'invite' });
  assert.equal(invite.accepted, false);
  await approve(f, reference);
  await assert.rejects(f.handler.applyApprovedPlan(f.owner, reference), /candidate enrollment/);
  await assert.rejects(f.governance.enrollCustodian(f.owner, { ...request, action: 'complete' }), /acceptance required/);
  await assert.rejects(f.governance.enrollCustodian(f.owner, { ...request, action: 'accept' }, { ...reference, caller: f.owner }), /authenticated candidate/);
  const candidate = f.caller(candidateId, 'candidate-consent');
  await assert.rejects(f.governance.enrollCustodian(candidate, { ...request, action: 'accept' }), /Independent exact/);
  const accepted = await f.governance.enrollCustodian(candidate, { ...request, action: 'accept' }, { ...reference, caller: candidate });
  assert.equal(accepted.accepted, true);
  const result = await f.governance.enrollCustodian(f.owner, { ...request, action: 'complete' });
  assert.equal(result.status, 'completed');
  assert.equal((await f.governance.enrollCustodian(f.owner, { ...request, action: 'complete' })).resultingGrantId, result.resultingGrantId);
  assert.equal((await orm.em.fork().findOneOrFail(CapabilityGrant, result.resultingGrantId!)).capability, 'governance.custodian');
  assert.equal(await orm.em.fork().count(CustodianEnrollment, { ...f.scope, planId: reference.planId }), 1);
});


test('expired approval evidence and terminal expired plans cannot authorize consumption', async () => {
  const f = await scenario(), { reference } = await proposal(f); await approve(f, reference);
  await orm.em.fork().execute("update plan_approval set approved_at=now()-interval '20 seconds', expires_at=now()-interval '10 seconds' where plan_id=? and approver_id=?", [reference.planId, approverA]);
  await assert.rejects(f.handler.applyApprovedPlan(f.owner, reference), /Insufficient distinct/);
  await orm.em.fork().transactional(async em => {
    const plan = await em.findOneOrFail(ActionPlan, reference.planId);
    plan.expire(plan.expiresAt);
  });
  await assert.rejects(f.handler.applyApprovedPlan(f.owner, reference), /not pending or has expired/);
  assert.equal(await orm.em.fork().count(CapabilityGrant, { ...f.scope, capability: 'guild.pause' }), 0);
});
