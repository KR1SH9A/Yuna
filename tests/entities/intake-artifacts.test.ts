import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { IntakeEvent } from '../../src/platform/intake/entities/intake-event.entity.js';
import { IntakeDelivery } from '../../src/platform/intake/entities/intake-delivery.entity.js';
import { ArtifactRecord } from '../../src/platform/artifacts/entities/artifact-record.entity.js';
import { assertDiscordId, copyJson } from '../../src/platform/db/entity-values.js';

const now = new Date('2026-10-15T10:00:00Z');
const later = (ms: number) => new Date(now.getTime() + ms);
const scope = () => ({ installationId: randomUUID(), guildId: '18446744073709551615', createdAt: now });

function event(kind: 'message_create' | 'message_delete' | 'report' = 'message_create') {
  return new IntakeEvent({ ...scope(), eventKind: kind, sourceEventKey: randomUUID(), sourceKey: 'channel/message',
    ingressSequence: 9_007_199_254_740_993n, observedAt: now, authorKind: 'unknown',
    contentAccess: 'unknown', coverage: ['original_body_missing'], purgeAfter: later(1000), metadataPurgeAfter: later(2000) });
}

test('Discord IDs are exact strings and JSON copying rejects silent data loss', () => {
  assert.doesNotThrow(() => assertDiscordId('18446744073709551615'));
  assert.throws(() => assertDiscordId('18446744073709551616'));
  assert.throws(() => assertDiscordId('01'));
  assert.throws(() => copyJson({ amount: Infinity }));
  assert.throws(() => copyJson({ omitted: undefined }));
  const input = { nested: { value: 'original' } };
  const copy = copyJson(input);
  input.nested.value = 'edited';
  assert.equal(copy.nested.value, 'original');
});

test('report events cannot replace current-message markers and deleted sources stay deleted', () => {
  assert.throws(() => event('report').markCurrent(1, 'present'));
  const deletion = event('message_delete');
  assert.throws(() => deletion.markCurrent(1, 'present'));
  deletion.markCurrent(1, 'deleted');
  deletion.purgePayload(later(1000), 'retention');
  assert.equal(deletion.sourceValidity, 'deleted');
  assert.equal(deletion.isCurrentSourceMarker, true);
  assert.equal(deletion.ingressSequence, 9_007_199_254_740_993n);
});

test('expired receipt claim is fenced after recovery and re-claim', () => {
  const receipt = new IntakeDelivery({ ...scope(), eventId: randomUUID(), owner: 'moderation', orderKey: 'message' });
  const first = receipt.claim('worker-a', now, later(100), receipt.rowRevision);
  receipt.recoverExpiredLease(later(100), receipt.rowRevision);
  const second = receipt.claim('worker-b', later(100), later(200), receipt.rowRevision);
  assert.throws(() => receipt.complete(first, 'handled', randomUUID(), later(150)));
  receipt.complete(second, 'handled', randomUUID(), later(150));
  assert.equal(receipt.state, 'DONE');
  assert.throws(() => receipt.claim('worker-c', later(160), later(200), receipt.rowRevision));
});

test('artifact deletion cannot overlook a late upload', () => {
  const artifact = new ArtifactRecord({ ...scope(), owner: 'moderation', ownerRecordRef: randomUUID(), retentionScope: 'evidence',
    storageKey: randomUUID(), accessBinding: { purpose: 'moderation' }, uploadDeadline: later(1000), expiresAt: later(2000) });
  artifact.beginDeletion(later(100), artifact.rowRevision);
  assert.throws(() => artifact.finalizeUpload('digest', 'image/png', 42, later(200), artifact.rowRevision));
  assert.throws(() => artifact.recordDeletion(later(999), artifact.rowRevision));
  artifact.recordDeletion(later(1000), artifact.rowRevision);
  assert.equal(artifact.isReadable(later(1100)), false);
  assert.equal(artifact.state, 'DELETED');
});

test('unavailable intake records a terminal disposition without stealing a live claim', () => {
  const receipt = new IntakeDelivery({ ...scope(), eventId: randomUUID(), owner: 'moderation', orderKey: 'message', processingDeadline: later(100) });
  const generation = receipt.claim('worker', now, later(50), receipt.rowRevision);
  assert.throws(() => receipt.disposeUnavailable('failed', 'original_purged', later(10), receipt.rowRevision));
  receipt.disposeUnavailable('expired', 'processing_deadline', later(100), receipt.rowRevision);
  assert.equal(receipt.state, 'DONE');
  assert.equal(receipt.outcome, 'expired');
  assert.throws(() => receipt.complete(generation, 'handled', randomUUID(), later(101)));
});
