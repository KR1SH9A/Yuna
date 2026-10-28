/** Exact bounded governance parsing rejects executable payloads, authority assertions and accidental native Administrator delegation. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { parseApprovePlanRequest, parseEnrollCustodianRequest, parseGovernanceOperations, parseProposePlanRequest } from '../../src/contexts/administration/dto/governance.dto.js';

const operation = { kind: 'grant_capability', granteeUserId: '100', capability: 'guild.pause', channelIds: ['300', '200'], targetUserIds: [], expiresAt: null };

test('exact plans normalize restriction order, detach caller objects and reject duplicate operations', () => {
  const value = { operations: [operation], sourceOperationKey: 'pause-grant', expiresAt: '2027-01-01T00:00:00Z' };
  const plan = parseProposePlanRequest(value);
  assert.deepEqual(plan.operations[0], { ...operation, channelIds: ['200', '300'] });
  assert.equal(plan.expiresAt, '2027-01-01T00:00:00.000Z');
  assert.notEqual(plan.operations[0], operation);
  assert.throws(() => parseGovernanceOperations([operation, operation]), /Duplicate/);
});

test('requests reject proposer/quorum/acceptance claims and unsupported native sanctions', () => {
  const reference = { planId: randomUUID(), planHash: 'a'.repeat(64) };
  assert.throws(() => parseApprovePlanRequest({ ...reference, approverId: '200' }), /Unknown/);
  assert.throws(() => parseEnrollCustodianRequest({ ...reference, candidateId: '100', action: 'accept', candidateAcceptedAt: new Date().toISOString() }), /Unknown/);
  assert.throws(() => parseGovernanceOperations([{ ...operation, capability: 'administration.manage' }]), /not delegable/);
  assert.throws(() => parseGovernanceOperations([{ kind: 'ban', targetUserId: '100' }]), /Unsupported/);
  assert.throws(() => parseProposePlanRequest({ operations: [operation], sourceOperationKey: 'x', expiresAt: '2027-01-01', minimumApprovals: 0 }), /Unknown/);
  assert.throws(() => parseGovernanceOperations(Array.from({ length: 11 }, () => operation)), /1 to 10/);
});

test('custodian enrollment is one exact guild-wide capability operation', () => {
  const custodian = { ...operation, capability: 'governance.custodian', channelIds: [] };
  assert.equal(parseGovernanceOperations([custodian])[0]?.kind, 'grant_capability');
  assert.throws(() => parseGovernanceOperations([{ ...custodian, channelIds: ['200'] }]), /exact guild/);
  assert.throws(() => parseGovernanceOperations([custodian, operation]), /one exact operation/);
  assert.throws(() => parseGovernanceOperations([{ kind: 'revoke_capability', grantId: randomUUID(), expectedAuthorityRevision: 0, expectedRowRevision: 0, reasonCode: 'request' }]), /revision/);
});
