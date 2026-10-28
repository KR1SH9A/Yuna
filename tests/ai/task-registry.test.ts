/** Verify exact version resolution, bounded concurrency and fair scanning across enabled worker routes. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { TaskRegistry } from '../../apps/ai-worker/task.registry.js';

const signal = new AbortController().signal;

test('only exact enabled routes resolve and each successful turn rotates to the next owner', async () => {
  const calls: string[] = [];
  const registry = new TaskRegistry({ /** Simulate a persistently busy conversation queue. */
    async runOne() { calls.push('community.generate'); return true; } },
  { /** Simulate both moderation stages without admitting arbitrary kind strings. */
    async runOne(_signal, kind) { calls.push(kind); return true; } },
  { /** Simulate a busy consented Debate queue. */
    async runOne() { calls.push('debates.assess'); return true; } });
  for (let i = 0; i < 5; i++) assert.equal(await registry.runOne(signal), true);
  assert.deepEqual(calls, ['community.generate', 'moderation.observe', 'moderation.assess', 'debates.assess', 'community.generate']);
  assert.equal(registry.resolveHandler('community.generate', 2), null);
  assert.equal(registry.resolveHandler('invented.execute', 1), null);
  assert.equal(Object.isFrozen(registry.resolveHandler('community.generate', 1)), true);
});

test('empty queues scan once and disabled capabilities cannot select a handler', async () => {
  let calls = 0;
  const registry = new TaskRegistry({ /** Report no durable claim in this scan. */ async runOne() { calls++; return false; } }, null, null);
  assert.equal(registry.resolveHandler('moderation.observe', 1), null);
  assert.equal(registry.resolveHandler('debates.assess', 1), null);
  assert.equal(await registry.runOne(signal), false); assert.equal(calls, 1);
  assert.equal(await registry.runOne(AbortSignal.abort()), false); assert.equal(calls, 1);
});

test('failed routes advance fairness and cancellation prevents the next claim', async () => {
  const stop = new AbortController(), calls: string[] = [];
  const registry = new TaskRegistry({ /** Fail the first store before a claim is returned. */
    async runOne() { calls.push('conversation'); throw new Error('storage unavailable'); } },
  { /** Cancel the lane after this claim scan to prevent another route from starting. */
    async runOne() { calls.push('moderation'); stop.abort(); return false; } }, null);
  await assert.rejects(registry.runOne(stop.signal), /storage unavailable/);
  assert.equal(await registry.runOne(stop.signal), false);
  assert.deepEqual(calls, ['conversation', 'moderation']);
});
