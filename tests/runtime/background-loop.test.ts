/** Exercise wake/scan races, serial execution and recovery without a provider or database. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { runBackgroundLoop, type LoopWakeup } from '../../src/platform/runtime/background-loop.js';

/** Create a controlled checkpoint for the next asynchronous operation. */
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('a notification during a scan leads to another scan without waiting for the fallback', async () => {
  const controller = new AbortController();
  let scans = 0;
  const wakeup: LoopWakeup = {
    revision: 0,
    /** Wait at the fixture checkpoint until the test explicitly releases or cancels it. */
    async wait(revision) {
      assert.equal(revision, 0, 'The revision must be captured before scanning');
      assert.equal(this.revision, 1);
    },
  };
  await runBackgroundLoop({ signal: controller.signal, intervalMs: 5_000, wakeup,
    onError: () => assert.fail('Unexpected error'),
    /** Execute one controlled loop iteration and expose its timing or failure to the test. */
    async run() {
      scans++;
      if (scans === 1) Object.assign(wakeup, { revision: 1 });
      else controller.abort();
    },
  });
  assert.equal(scans, 2);
});

test('claimed tasks drain immediately but one consumer never overlaps its own work', async () => {
  const controller = new AbortController();
  const entered = gate();
  const release = gate();
  let calls = 0;
  const running = runBackgroundLoop({ signal: controller.signal, intervalMs: 5_000,
    wakeup: { revision: 0, /** Wait at the fixture checkpoint until the test explicitly releases or cancels it. */ async wait() { assert.fail('There is still work to drain'); } },
    onError: () => assert.fail('Unexpected error'),
    /** Execute one controlled loop iteration and expose its timing or failure to the test. */
    async run() {
      calls++;
      if (calls === 1) { entered.resolve(); await release.promise; }
      else controller.abort();
      return true;
    },
  });
  await entered.promise;
  assert.equal(calls, 1);
  release.resolve();
  await running;
  assert.equal(calls, 2);
});

test('maintenance uses its own cadence and cancellation interrupts a long idle wait', async () => {
  const controller = new AbortController();
  const second = gate();
  let calls = 0;
  const running = runBackgroundLoop({ signal: controller.signal, intervalMs: 20,
    onError: () => assert.fail('Unexpected error'), /** Execute one controlled loop iteration and expose its timing or failure to the test. */ async run() {
      if (++calls === 2) second.resolve();
    } });
  try {
    assert.equal(calls, 1);
    await second.promise;
    assert.equal(calls, 2);
    controller.abort();
    await running;
    // A separate long wait must also settle immediately when canceled.
    const waiting = new AbortController();
    const idle = runBackgroundLoop({ signal: waiting.signal, intervalMs: 60_000,
      onError: () => assert.fail('Unexpected error'), /** Execute one controlled loop iteration and expose its timing or failure to the test. */ async run() {} });
    await Promise.resolve();
    waiting.abort();
    await idle;
  } finally { controller.abort(); await running; }
}, 2_000);

test('a failing consumer backs off instead of spinning on notifications', async () => {
  const controller = new AbortController();
  let calls = 0;
  let errors = 0;
  const failed = gate();
  const running = runBackgroundLoop({ signal: controller.signal, intervalMs: 20,
    wakeup: { revision: 1, /** Wait at the fixture checkpoint until the test explicitly releases or cancels it. */ async wait() { assert.fail('Failure must use backoff'); } },
    /** Observe the loop's error callback without logging raw driver errors. */
    onError() { errors++; failed.resolve(); }, /** Execute one controlled loop iteration and expose its timing or failure to the test. */ async run() {
      calls++;
      if (calls === 2) controller.abort();
      throw new Error('fixture-secret-not-logged');
    } });
  try {
    await failed.promise;
    assert.equal(calls, 1);
    await running;
    assert.equal(calls, 2);
    assert.equal(errors, 1);
  } finally { controller.abort(); await running; }
}, 2_000);

test('slow maintenance cannot prevent a separate reply consumer from running', async () => {
  const controller = new AbortController();
  const entered = gate();
  const release = gate();
  const maintenance = runBackgroundLoop({ signal: controller.signal, intervalMs: 60_000,
    onError: () => assert.fail('Unexpected error'), /** Execute one controlled loop iteration and expose its timing or failure to the test. */ async run() { entered.resolve(); await release.promise; } });
  await entered.promise;
  let handled = false;
  await runBackgroundLoop({ signal: controller.signal, intervalMs: 5_000,
    onError: () => assert.fail('Unexpected error'), /** Execute one controlled loop iteration and expose its timing or failure to the test. */ async run() { handled = true; controller.abort(); } });
  assert.equal(handled, true);
  release.resolve();
  await maintenance;
});
