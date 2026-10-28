/** Timing telemetry must remain bounded and cannot leak payloads or interrupt business work. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { createLatencyLogger, noLatencyReporter, reportLatency, type LatencySample } from '../../src/platform/runtime/latency.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';

test('structured latency logs include only fixed labels, rounded duration and internal UUIDs', () => {
  const lines: string[] = [];
  const logger = createLatencyLogger('bot', line => { lines.push(line); });
  const sample = { stage: 'queue_wait', durationMs: 12.3456, taskId, requestId, outcome: 'accepted',
    content: 'secret-message', userId: '940000000000000003', error: new Error('secret-error') } as const;
  logger(sample);
  assert.deepEqual(JSON.parse(lines[0]!), { event: 'conversation_latency', role: 'bot', stage: 'queue_wait',
    durationMs: 12.35, requestId, taskId, outcome: 'accepted' });
  assert.ok(!lines[0]!.includes('secret'));
});

test('invalid labels, durations and external IDs cannot enter the telemetry stream', () => {
  const samples: LatencySample[] = [];
  const valid: LatencySample = { stage: 'provider', durationMs: 5, taskId, outcome: 'success' };
  for (const override of [{ stage: 'secret' }, { outcome: 'secret' }, { durationMs: NaN },
    { durationMs: Infinity }, { durationMs: Number.MAX_VALUE }, { durationMs: -1 }, { taskId: '940000000000000003' }]) {
    reportLatency(sample => { samples.push(sample); }, { ...valid, ...override } as LatencySample);
  }
  assert.equal(samples.length, 0);
  reportLatency(sample => { samples.push(sample); }, { ...valid, requestId: 'secret-request' });
  assert.deepEqual(samples, [valid]);
});

test('a broken telemetry writer never throws back into the conversation pipeline', () => {
  const sample: LatencySample = { stage: 'provider', durationMs: 5, taskId, outcome: 'success' };
  assert.doesNotThrow(() => reportLatency(() => { throw new Error('writer-unavailable'); }, sample));
  assert.doesNotThrow(() => createLatencyLogger('ai-worker', () => { throw new Error('writer-unavailable'); })(sample));
  assert.doesNotThrow(() => noLatencyReporter(sample));
});
