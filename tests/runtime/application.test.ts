import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from '@jest/globals';
import { startApplication, StartupCancelledError, type RuntimeResource } from '../../src/platform/runtime/application.js';

/** Explicit hand-offs keep lifecycle races deterministic without sleeping or faking timers. */
function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** Diagnostics may identify lifecycle stages/resources, but must never retain adapter secrets. */
function assertSanitized(error: unknown, secrets: readonly string[]): asserts error is Error {
  assert.ok(error instanceof Error);
  assert.equal(error.cause, undefined);
  const diagnostic = `${inspect(error, { showHidden: true, depth: null })}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
  for (const secret of secrets) assert.equal(diagnostic.includes(secret), false);
}

test('resources start sequentially and a frozen resource list stops in reverse order', async () => {
  const events: string[] = [];
  const entered = gate();
  const releaseStart = gate();
  const resources: readonly RuntimeResource[] = Object.freeze([
    Object.freeze({
      name: 'database',
      async start(signal: AbortSignal) {
        assert.equal(signal.aborted, false);
        events.push('database:start');
        entered.release();
        await releaseStart.promise;
        events.push('database:ready');
      },
      async stop() { events.push('database:stop'); },
    }),
    Object.freeze({
      name: 'gateway',
      async start() { events.push('gateway:start'); },
      async stop() { events.push('gateway:stop'); },
    }),
  ]);
  const startup = startApplication(resources);
  await entered.promise;
  assert.deepEqual(events, ['database:start']);
  releaseStart.release();
  const application = await startup;
  assert.deepEqual(events, ['database:start', 'database:ready', 'gateway:start']);
  await application.shutdown();
  assert.deepEqual(events, ['database:start', 'database:ready', 'gateway:start', 'gateway:stop', 'database:stop']);
  assert.deepEqual(resources.map(resource => resource.name), ['database', 'gateway']);
});

test('a failed start cleans its partial resource before earlier resources and skips later ones', async () => {
  const events: string[] = [];
  const secret = 'private-start-credential';
  const resources: RuntimeResource[] = [
    { name: 'database', async start() { events.push('database:start'); }, async stop() { events.push('database:stop'); } },
    {
      name: 'worker',
      async start() { events.push('worker:start'); throw new Error(secret, { cause: new Error(secret) }); },
      async stop() { events.push('worker:stop'); },
    },
    { name: 'gateway', async start() { events.push('gateway:start'); }, async stop() { events.push('gateway:stop'); } },
  ];
  await assert.rejects(startApplication(resources), (error: unknown) => {
    assertSanitized(error, [secret]);
    assert.match(error.message, /worker|start/i);
    return true;
  });
  assert.deepEqual(events, ['database:start', 'worker:start', 'worker:stop', 'database:stop']);
});

test('rollback continues after a cleanup rejection without exposing either adapter failure', async () => {
  const events: string[] = [];
  const startSecret = 'private-provider-start';
  const stopSecret = 'private-provider-stop';
  await assert.rejects(startApplication([
    { name: 'database', async start() { events.push('database:start'); }, async stop() { events.push('database:stop'); } },
    {
      name: 'provider',
      async start() { events.push('provider:start'); throw new Error(startSecret); },
      async stop() { events.push('provider:stop'); throw new Error(stopSecret, { cause: new Error(stopSecret) }); },
    },
    { name: 'consumer', async start() { events.push('consumer:start'); }, async stop() { events.push('consumer:stop'); } },
  ]), (error: unknown) => {
    assertSanitized(error, [startSecret, stopSecret]);
    return true;
  });
  assert.deepEqual(events, ['database:start', 'provider:start', 'provider:stop', 'database:stop']);
});

test('a signal arriving during rollback does not reclassify an earlier startup failure as cancellation', async () => {
  const events: string[] = [];
  const cleanupEntered = gate();
  const releaseCleanup = gate();
  const controller = new AbortController();
  const secret = 'private-start-failure-before-abort';
  const startup = startApplication([
    { name: 'database', async start() { events.push('database:start'); }, async stop() { events.push('database:stop'); } },
    {
      name: 'worker',
      async start() { events.push('worker:start'); throw new Error(secret); },
      async stop() { events.push('worker:stop'); cleanupEntered.release(); await releaseCleanup.promise; },
    },
  ], controller.signal);
  const rejected = assert.rejects(startup, (error: unknown) => {
    assertSanitized(error, [secret]);
    assert.equal(error instanceof StartupCancelledError, false);
    assert.match(error.message, /start.*fail/i);
    return true;
  });
  await cleanupEntered.promise;
  controller.abort();
  releaseCleanup.release();
  await rejected;
  assert.deepEqual(events, ['database:start', 'worker:start', 'worker:stop', 'database:stop']);
});

test('concurrent and repeated shutdown share one promise and stop each resource exactly once', async () => {
  const events: string[] = [];
  const stopEntered = gate();
  const releaseStop = gate();
  const application = await startApplication([
    { name: 'database', async start() {}, async stop() { events.push('database:stop'); } },
    {
      name: 'gateway', async start() {},
      async stop() { events.push('gateway:stop'); stopEntered.release(); await releaseStop.promise; events.push('gateway:closed'); },
    },
  ]);
  const first = application.shutdown();
  const concurrent = application.shutdown();
  assert.equal(concurrent, first);
  await stopEntered.promise;
  assert.deepEqual(events, ['gateway:stop']);
  releaseStop.release();
  await Promise.all([first, concurrent]);
  assert.equal(application.shutdown(), first);
  await application.shutdown();
  assert.deepEqual(events, ['gateway:stop', 'gateway:closed', 'database:stop']);
});

test('shutdown attempts every resource even when multiple stops reject and never retries them', async () => {
  const stopped: string[] = [];
  const firstSecret = 'private-worker-shutdown';
  const secondSecret = 'private-gateway-shutdown';
  const application = await startApplication([
    { name: 'database', async start() {}, async stop() { stopped.push('database'); } },
    { name: 'worker', async start() {}, async stop() { stopped.push('worker'); throw new Error(firstSecret); } },
    { name: 'gateway', async start() {}, async stop() { stopped.push('gateway'); throw new Error(secondSecret); } },
  ]);
  const shutdown = application.shutdown();
  assert.equal(application.shutdown(), shutdown);
  await assert.rejects(shutdown, (error: unknown) => {
    assertSanitized(error, [firstSecret, secondSecret]);
    assert.match(error.message, /stop|shutdown|gateway|worker/i);
    return true;
  });
  assert.equal(application.shutdown(), shutdown);
  assert.deepEqual(stopped, ['gateway', 'worker', 'database']);
});

test('an already aborted startup never touches resources or exposes the abort reason', async () => {
  const events: string[] = [];
  const secret = 'private-abort-reason';
  const controller = new AbortController();
  controller.abort(new Error(secret));
  await assert.rejects(startApplication([
    { name: 'database', async start() { events.push('start'); }, async stop() { events.push('stop'); } },
  ], controller.signal), (error: unknown) => {
    assertSanitized(error, [secret]);
    assert.match(error.message, /abort|start/i);
    return true;
  });
  assert.deepEqual(events, []);
});

test('abort during a start waits for that attempt before rollback and prevents later starts', async () => {
  const events: string[] = [];
  const entered = gate();
  const releaseStart = gate();
  const controller = new AbortController();
  let startFinished = false;
  let stoppedWhileStarting = false;
  const secret = 'private-inflight-abort';
  const startup = startApplication([
    { name: 'database', async start() { events.push('database:start'); }, async stop() { events.push('database:stop'); } },
    {
      name: 'gateway',
      async start(signal) {
        events.push('gateway:start');
        entered.release();
        await releaseStart.promise;
        assert.equal(signal.aborted, true);
        startFinished = true;
        events.push('gateway:ready');
      },
      async stop() { stoppedWhileStarting = !startFinished; events.push('gateway:stop'); },
    },
    { name: 'consumer', async start() { events.push('consumer:start'); }, async stop() { events.push('consumer:stop'); } },
  ], controller.signal);
  // Install the rejection handler before signaling abort, including for broken early-reject implementations.
  const rejected = assert.rejects(startup, (error: unknown) => {
    assertSanitized(error, [secret]);
    return true;
  });
  await entered.promise;
  controller.abort(new Error(secret));
  await Promise.resolve();
  assert.deepEqual(events, ['database:start', 'gateway:start']);
  releaseStart.release();
  await rejected;
  assert.equal(startFinished, true);
  assert.equal(stoppedWhileStarting, false);
  assert.deepEqual(events, ['database:start', 'gateway:start', 'gateway:ready', 'gateway:stop', 'database:stop']);
});

test('startup captures its resource list before the caller changes it', async () => {
  const events: string[] = [];
  const entered = gate();
  const releaseStart = gate();
  const resources: RuntimeResource[] = [
    { name: 'database', async start() { events.push('database:start'); entered.release(); await releaseStart.promise; }, async stop() { events.push('database:stop'); } },
    { name: 'gateway', async start() { events.push('gateway:start'); }, async stop() { events.push('gateway:stop'); } },
  ];
  const startup = startApplication(resources);
  await entered.promise;
  resources.splice(0, resources.length, {
    name: 'replacement', async start() { events.push('replacement:start'); }, async stop() { events.push('replacement:stop'); },
  });
  releaseStart.release();
  const application = await startup;
  await application.shutdown();
  assert.deepEqual(events, ['database:start', 'gateway:start', 'gateway:stop', 'database:stop']);
  assert.equal(resources[0]?.name, 'replacement');
});

test('separate applications keep independent shutdown state and leave process settings alone', async () => {
  const envBefore = { ...process.env };
  const signalListenersBefore = { interrupt: process.listenerCount('SIGINT'), terminate: process.listenerCount('SIGTERM') };
  const stopped: string[] = [];
  const first = await startApplication([{ name: 'first', async start() {}, async stop() { stopped.push('first'); } }]);
  const second = await startApplication([{ name: 'second', async start() {}, async stop() { stopped.push('second'); } }]);
  await first.shutdown();
  assert.deepEqual(stopped, ['first']);
  await second.shutdown();
  assert.deepEqual(stopped, ['first', 'second']);
  assert.deepEqual({ ...process.env }, envBefore);
  assert.deepEqual({ interrupt: process.listenerCount('SIGINT'), terminate: process.listenerCount('SIGTERM') }, signalListenersBefore);
});
