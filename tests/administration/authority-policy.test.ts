/** Pure permission and argument tests cover forged bindings, Discord hierarchy and strict command DTOs. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { AuthorityPolicy } from '../../src/contexts/administration/authority.policy.js';
import type { AuthorityOperation, CurrentNativeFacts, TrustedCallerContext } from '../../src/contexts/administration/contracts.js';
import { parseGrantCapabilityRequest, parseRevokeGrantRequest } from '../../src/contexts/administration/dto/grant-revocation.dto.js';
import { parsePauseGuildRequest, parseResumeGuildRequest } from '../../src/contexts/administration/dto/guild-safety.dto.js';

const policy = new AuthorityPolicy();
const now = new Date('2026-10-21T10:00:00Z');
const caller: TrustedCallerContext = { actorId: '100', guildId: '101', installationId: '00000000-0000-0000-0000-000000000001', sourceRequestId: 'interaction:1' };
const ban: AuthorityOperation = { capability: 'moderation.ban', targetUserId: '102' };

/** A complete current REST observation; individual tests change only the relevant permission boundary. */
function facts(operation = ban): CurrentNativeFacts {
  return { guildId: caller.guildId, actorId: caller.actorId, sourceRequestId: caller.sourceRequestId, operation,
    observedAt: now, complete: true, ownerId: '103', actorIsMember: true, actorPermissions: '4', botPermissions: '4',
    target: { userId: '102', isMember: true, isGuildOwner: false, isSelf: false, actorAboveTarget: true, botAboveTarget: true } };
}

test('native facts must match actor, guild, source request and exact operation', () => {
  for (const change of [{ actorId: '999' }, { guildId: '999' }, { sourceRequestId: 'forged' },
    { operation: { ...ban, targetUserId: '999' } }, { operation: { ...ban, channelId: '999' } }, { complete: false }]) {
    assert.equal(policy.canExecute(caller, ban, { ...facts(), ...change }, now), 'native_facts_mismatch');
  }
});

test('native facts expire and cannot claim to come from the future', () => {
  for (const time of [new Date(now.getTime() - 5001), new Date(now.getTime() + 1), new Date(NaN)]) {
    assert.equal(policy.canExecute(caller, ban, { ...facts(), observedAt: time }, now), 'native_facts_stale');
  }
});

test('administrator privilege does not bypass bot or staff target hierarchy', () => {
  const base = { ...facts(), actorPermissions: '8', botPermissions: '8' };
  assert.equal(policy.canExecute(caller, ban, base, now), null);
  assert.equal(policy.canExecute(caller, ban, { ...base, target: { ...base.target!, botAboveTarget: false } }, now), 'target_hierarchy_denied');
  assert.equal(policy.canExecute(caller, ban, { ...base, target: { ...base.target!, actorAboveTarget: false } }, now), 'target_hierarchy_denied');
});

test('native permission is required from both staff and bot, including large permission bitfields', () => {
  assert.equal(policy.canExecute(caller, ban, { ...facts(), actorPermissions: '0' }, now), 'native_permission_denied');
  assert.equal(policy.canExecute(caller, ban, { ...facts(), botPermissions: '0' }, now), 'native_permission_denied');
  assert.equal(policy.canExecute(caller, ban, { ...facts(), actorPermissions: ((1n << 60n) | 4n).toString() }, now), null);
  assert.equal(policy.canExecute(caller, ban, { ...facts(), actorPermissions: 'invalid' }, now), 'native_facts_incomplete');
});

test('ban protects the guild owner, acting staff and bot; kick requires a current member', () => {
  for (const change of [{ isGuildOwner: true }, { isSelf: true }]) {
    assert.equal(policy.canExecute(caller, ban, { ...facts(), target: { ...facts().target!, ...change } }, now), 'target_protected');
  }
  const kick: AuthorityOperation = { capability: 'moderation.kick', targetUserId: '102' };
  assert.equal(policy.canExecute(caller, kick, { ...facts(kick), actorPermissions: '2', botPermissions: '2', target: { ...facts().target!, isMember: false } }, now), 'target_not_member');
});

test('kick status keeps current exact native permission while allowing departed targets without weakening effect checks', () => {
  const kick: AuthorityOperation = { capability: 'moderation.kick', targetUserId: '102' };
  const departed = { ...facts(kick), actorPermissions: '2', botPermissions: '2',
    target: { ...facts().target!, isMember: false, actorAboveTarget: false, botAboveTarget: false } };
  assert.equal(policy.canExecute(caller, kick, departed, now, 'status'), null);
  assert.equal(policy.canExecute(caller, kick, departed, now), 'target_not_member');
  assert.equal(policy.canExecute(caller, kick, { ...departed, actorPermissions: '4' }, now, 'status'), 'native_permission_denied');
  assert.equal(policy.canExecute(caller, kick, { ...departed, botPermissions: '0' }, now, 'status'), 'native_permission_denied');
  assert.equal(policy.canExecute(caller, kick, { ...departed, target: { ...departed.target, userId: '999' } }, now, 'status'), 'target_facts_missing');
  assert.equal(policy.canExecute(caller, kick, { ...departed, sourceRequestId: 'forged' }, now, 'status'), 'native_facts_mismatch');
});

test('unban requires a current administrator but not current target guild membership', () => {
  const operation: AuthorityOperation = { capability: 'moderation.unban', targetUserId: '102' };
  assert.equal(policy.canExecute(caller, operation, facts(operation), now), 'native_administrator_required');
  assert.equal(policy.canExecute(caller, operation, { ...facts(operation), actorPermissions: '8',
    target: { ...facts().target!, isMember: false, actorAboveTarget: false, botAboveTarget: false } }, now), null);
});

test('baseline grant management requires current ownership; native Administrator alone cannot bootstrap', () => {
  const operation: AuthorityOperation = { capability: 'administration.manage' };
  assert.equal(policy.canExecute(caller, operation, { ...facts(operation), actorPermissions: '8' }, now), 'current_owner_required');
  assert.equal(policy.canExecute(caller, operation, { ...facts(operation), ownerId: caller.actorId, actorPermissions: '0' }, now), null);
});

test('grant DTO rejects forged identity, unknown capability and duplicate scopes, and detaches accepted arrays', () => {
  const input = { granteeUserId: '200', capability: 'guild.pause', scope: { channelIds: ['300', '201'], targetUserIds: [] }, sourceOperationKey: 'grant-1', expiresAt: null };
  assert.throws(() => parseGrantCapabilityRequest({ ...input, actorId: 'forged' }), /Unknown/);
  assert.throws(() => parseGrantCapabilityRequest({ ...input, capability: 'administration.manage' }), /not delegable/);
  assert.throws(() => parseGrantCapabilityRequest({ ...input, scope: { channelIds: ['201', '201'], targetUserIds: [] } }), /Duplicate/);
  const parsed = parseGrantCapabilityRequest(input);
  input.scope.channelIds.push('900');
  assert.deepEqual(parsed.scope.channelIds, ['201', '300']);
});

test('safety and revoke arguments require exact revisions and reject approval/identity claims', () => {
  assert.throws(() => parsePauseGuildRequest({ expectedSafetyRevision: -1, reasonCode: 'test' }), /nonnegative/);
  assert.throws(() => parseResumeGuildRequest({ expectedSafetyRevision: 0, approved: true }), /Unknown/);
  assert.throws(() => parseRevokeGrantRequest({ grantId: caller.installationId, expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'test', guildId: caller.guildId }), /Unknown/);
  assert.deepEqual(parsePauseGuildRequest({ expectedSafetyRevision: 0, reasonCode: 'operator_pause' }), { expectedSafetyRevision: 0, reasonCode: 'operator_pause' });
  assert.deepEqual(parseResumeGuildRequest({ expectedSafetyRevision: 1 }), { expectedSafetyRevision: 1 });
});
