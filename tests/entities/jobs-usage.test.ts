/** Test task state transitions, attempt ownership and exact accounting behavior on isolated entities. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { AiTask } from '../../src/platform/jobs/entities/ai-task.entity.js';
import { OutboxEntry } from '../../src/platform/jobs/entities/outbox-entry.entity.js';
import { PreparedInput } from '../../src/platform/jobs/entities/prepared-input.entity.js';
import { TaskAttempt } from '../../src/platform/jobs/entities/task-attempt.entity.js';
import { TaskResult } from '../../src/platform/jobs/entities/task-result.entity.js';
import { UsageEntry } from '../../src/platform/usage/entities/usage-entry.entity.js';
import { UsageReservation, assertExactMoney, type UsageEvidence } from '../../src/platform/usage/entities/usage-reservation.entity.js';

/** Create an independent UUID for a fixture-owned record. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Convert relative fixture seconds to a deterministic timestamp. */
const at = (seconds: number) => new Date(Date.parse('2026-10-15T10:00:00.000Z') + seconds * 1000);
const scope = { installationId: id(1), guildId: '18446744073709551615', createdAt: at(0) };
/** Build the evidence binding needed by the task fixture. */
const evidence = (kind: UsageEvidence['kind'], seconds: number): UsageEvidence => ({ kind, reference: `billing:${kind}:${seconds}`, observedAt: at(seconds).toISOString() });

/** Build a valid task fixture with one explicitly bound owner operation. */
function task(): AiTask {
  return new AiTask({ ...scope, id: id(2), owner: 'moderation', operationKey: 'case:1:assessment:1', kind: 'moderation.assess', schemaVersion: 1, preparedInputId: id(3), inputHash: 'sha256:input', sourceUse: 'original_evidence', validityBindings: { evidenceRevisionId: id(4) }, providerConfigurationVersion: 'provider-v1', modelVersion: 'model-v1', promptVersion: 'prompt-v1', maxAttempts: 2, deadline: at(100) });
}

/** Build an exact-money usage reservation with a fixed accounting window. */
function reservation(): UsageReservation {
  return new UsageReservation({ ...scope, id: id(10), feature: 'moderation', provider: 'test', modelRoute: 'route-v1', operationKind: 'task-attempt', operationKey: 'task:2:attempt:1', taskId: id(2), attemptNumber: 1, reservedUnits: { input_tokens: 500 }, reservedCost: { amount: '0.100000000000000001', currency: 'USD' }, usagePolicyId: id(11), policyRevision: 1, policySnapshot: { maxDailyCost: '1.00' }, pricingVersion: 'price-v1', budgetWindows: [{ key: 'guild:daily', startsAt: at(-3600).toISOString(), endsAt: at(3600).toISOString() }], reconcileAfter: at(60), purgeAfter: at(600) });
}

/** Build unresolved usage evidence so the test can exercise later reconciliation. */
function estimatedUsage(): UsageEntry {
  return new UsageEntry({ ...scope, id: id(12), reservationId: id(10), operationKind: 'task-attempt', operationKey: 'task:2:attempt:1', attemptId: id(5), provider: 'test', pricingVersion: 'price-v1', currency: 'USD', accountingState: 'estimated', estimatedCost: '0.100000000000000001', evidence: evidence('timeout', 1), reconcileAfter: at(60), purgeAfter: at(600) });
}

test('retry creates a new authority generation and a terminal task cannot reopen', () => {
  const value = task();
  const first = value.claimAttempt(id(5), at(1));
  value.scheduleRetry(id(5), first, at(5), at(2));
  assert.throws(() => value.claimAttempt(id(6), at(4)), /not due/);
  const second = value.claimAttempt(id(6), at(5));
  assert.throws(() => value.assertCurrentAttempt(id(5), first), /authority/);
  assert.throws(() => value.finalize(first, at(6)), /Stale/);
  assert.throws(() => value.scheduleRetry(id(6), second, at(8), at(6)), /Attempt limit/);
  value.finalize(second, at(7));
  assert.throws(() => value.finalize(second, at(8)), /Terminal/);
  assert.throws(() => value.claimAttempt(id(7), at(8)), /not claimable/);
});

test('counter exhaustion rejects before partially claiming a task', () => {
  const value = task();
  value.rowRevision = 2_147_483_647;
  assert.throws(() => value.claimAttempt(id(5), at(1)), /revision exhausted/);
  assert.equal(value.state, 'READY');
  assert.equal(value.activeAttemptId, null);
});

test('prepared input is revoked before erasure and cannot be released after expiry', () => {
  const value = new PreparedInput({ ...scope, id: id(3), taskId: id(2), schemaVersion: 1, payload: { originalContent: 'captured original' }, contentHash: 'sha256:input', artifactHandles: [], provenance: { eventId: id(8) }, purpose: 'moderation', audience: { kind: 'internal' }, sourceUse: 'original_evidence', validityBindings: { evidenceRevisionId: id(4) }, expiresAt: at(30), purgeAfter: at(60) });
  value.assertDisclosable(at(1));
  assert.throws(() => value.assertDisclosable(at(30)), /expired/);
  assert.throws(() => value.purgePayload('privacy', at(2)), /Invalidate/);
  value.invalidate('privacy', at(2));
  assert.throws(() => value.assertDisclosable(at(3)), /unavailable/);
  value.purgePayload('privacy', at(3));
  assert.equal(value.payload, null);
  assert.equal(value.sourceUse, 'original_evidence');
});

test('an expired or fenced attempt cannot renew, release input or publish a result', () => {
  const value = new TaskAttempt({ ...scope, id: id(5), taskId: id(2), attemptNumber: 1, generation: 1, executorId: 'worker:1', reservationId: id(10), leaseUntil: at(10) });
  assert.throws(() => value.recordProviderStart(1, at(1)), /released input/);
  value.recordInputRelease(1, at(1));
  value.recordProviderStart(1, at(2));
  assert.throws(() => value.renewLease(1, at(20), at(10)), /lost its lease/);
  assert.throws(() => value.finish(1, at(10)), /lost its lease/);
  value.fence(at(11));
  assert.throws(() => value.recordInputRelease(1, at(12)), /lost its lease/);
  assert.throws(() => value.finish(1, at(12)), /lost its lease/);
});

test('purging an unacknowledged result retains an unavailable terminal envelope', () => {
  const value = new TaskResult({ ...scope, id: id(9), taskId: id(2), attemptId: id(5), attemptGeneration: 1, schemaVersion: 1, outcome: 'success', payload: { acceptedFacts: ['original evidence'] }, reason: 'completed', purgeAfter: at(60) });
  assert.throws(() => value.purgePayload({ reason: 'cleanup', mode: 'owner_acknowledged', ownerAcknowledged: false, now: at(1) }), /acknowledgment/);
  assert.throws(() => value.purgePayload({ reason: 'retention', mode: 'retention', ownerAcknowledged: false, now: at(1) }), /not due/);
  value.purgePayload({ reason: 'erasure', mode: 'privacy', ownerAcknowledged: false, now: at(2) });
  assert.equal(value.outcome, 'success');
  assert.equal(value.payload, null);
  assert.equal(value.payloadUnavailable, true);
  assert.equal(value.pendingOwnerDiscard, true);
  value.recordOwnerAcknowledgment(at(3));
  assert.equal(value.pendingOwnerDiscard, false);
});

test('publication retries fence an old relay without claiming consumer acceptance', () => {
  const value = new OutboxEntry({ ...scope, topic: 'task.complete', schemaVersion: 1, recordId: id(2), deduplicationKey: 'complete:task2' });
  const oldClaim = value.claim('relay:1', at(10), at(1));
  const currentClaim = value.claim('relay:2', at(20), at(10));
  assert.throws(() => value.recordPublished(oldClaim, at(11)), /stale/);
  value.recordPublished(currentClaim, at(11));
  assert.throws(() => value.claim('relay:3', at(30), at(21)), /not claimable/);
});

test('timeout retains liability past retention and late actual billing can exceed its estimate', () => {
  const reserved = reservation();
  reserved.bindAttempt(id(5), at(1));
  assert.throws(() => reserved.bindAttempt(id(6), at(2)), /reassigned/);
  reserved.markLiability(evidence('timeout', 2), at(60), at(2));
  assert.throws(() => reserved.releaseUnused(evidence('lease_expired', 3), at(3)), /no-spend evidence/);
  assert.equal(reserved.canPurge(at(700)), false);
  const usage = estimatedUsage();
  usage.recordActual({ amount: '1.900000000000000007', currency: 'USD' }, { input_tokens: 1500 }, evidence('provider_invoice', 700), at(700));
  reserved.settle(evidence('provider_invoice', 700), at(700));
  assert.equal(usage.actualCost, '1.900000000000000007');
  assert.equal(reserved.canPurge(at(701)), true);
  assert.throws(() => usage.recordUncertainty(evidence('timeout', 702), at(800), at(702)), /known actual/);
});

test('positive no-spend evidence resolves uncertainty; a correction remains explicit', () => {
  const reserved = reservation();
  const usage = estimatedUsage();
  assert.throws(() => usage.recordNoSpend(evidence('timeout', 2), at(2)), /do not prove/);
  usage.recordNoSpend(evidence('provider_no_spend', 3), at(3));
  reserved.releaseUnused(evidence('provider_no_spend', 3), at(3));
  assert.throws(() => usage.recordActual({ amount: '1', currency: 'USD' }, undefined, evidence('provider_invoice', 4), at(4)), /explicit billing correction/);
  usage.recordBillingCorrection({ amount: '1', currency: 'USD' }, undefined, evidence('billing_correction', 5), at(5));
  reserved.settle(evidence('billing_correction', 5), at(5));
  assert.equal(usage.actualCost, '1');
  assert.equal(usage.evidence.some(item => item.kind === 'provider_no_spend'), true);
  assert.throws(() => usage.recordNoSpend(evidence('provider_no_spend', 6), at(6)), /Known spend/);
});

test('money rejects floats, exponent notation and unsupported precision', () => {
  assert.doesNotThrow(() => assertExactMoney({ amount: '99999999999999999999.999999999999999999', currency: 'USD' }));
  assert.throws(() => assertExactMoney({ amount: 0.3 as unknown as string, currency: 'USD' }), /decimal string/);
  assert.throws(() => assertExactMoney({ amount: '1e-3', currency: 'USD' }), /decimal string/);
  assert.throws(() => assertExactMoney({ amount: '0.0000000000000000001', currency: 'USD' }), /decimal string/);
  assert.throws(() => assertExactMoney({ amount: '-0.01', currency: 'USD' }), /decimal string/);
});
