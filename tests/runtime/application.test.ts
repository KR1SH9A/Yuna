/** Check resource startup order, rollback and shutdown, including failures and cancellation. */
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
      /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */
      async start(signal: AbortSignal) {
        assert.equal(signal.aborted, false);
        events.push('database:start');
        entered.release();
        await releaseStart.promise;
        events.push('database:ready');
      },
      /** Simulate resource cleanup and expose its order or selected failure to the test. */
      async stop() { events.push('database:stop'); },
    }),
    Object.freeze({
      name: 'gateway',
      /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */
      async start() { events.push('gateway:start'); },
      /** Simulate resource cleanup and expose its order or selected failure to the test. */
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
    { name: 'database', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('database:start'); }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('database:stop'); } },
    {
      name: 'worker',
      /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */
      async start() { events.push('worker:start'); throw new Error(secret, { cause: new Error(secret) }); },
      /** Simulate resource cleanup and expose its order or selected failure to the test. */
      async stop() { events.push('worker:stop'); },
    },
    { name: 'gateway', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('gateway:start'); }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('gateway:stop'); } },
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
    { name: 'database', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('database:start'); }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('database:stop'); } },
    {
      name: 'provider',
      /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */
      async start() { events.push('provider:start'); throw new Error(startSecret); },
      /** Simulate resource cleanup and expose its order or selected failure to the test. */
      async stop() { events.push('provider:stop'); throw new Error(stopSecret, { cause: new Error(stopSecret) }); },
    },
    { name: 'consumer', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('consumer:start'); }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('consumer:stop'); } },
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
    { name: 'database', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('database:start'); }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('database:stop'); } },
    {
      name: 'worker',
      /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */
      async start() { events.push('worker:start'); throw new Error(secret); },
      /** Simulate resource cleanup and expose its order or selected failure to the test. */
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
    { name: 'database', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() {}, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('database:stop'); } },
    {
      name: 'gateway', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() {},
      /** Simulate resource cleanup and expose its order or selected failure to the test. */
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
    { name: 'database', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() {}, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { stopped.push('database'); } },
    { name: 'worker', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() {}, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { stopped.push('worker'); throw new Error(firstSecret); } },
    { name: 'gateway', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() {}, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { stopped.push('gateway'); throw new Error(secondSecret); } },
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
    { name: 'database', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('start'); }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('stop'); } },
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
    { name: 'database', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('database:start'); }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('database:stop'); } },
    {
      name: 'gateway',
      /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */
      async start(signal) {
        events.push('gateway:start');
        entered.release();
        await releaseStart.promise;
        assert.equal(signal.aborted, true);
        startFinished = true;
        events.push('gateway:ready');
      },
      /** Simulate resource cleanup and expose its order or selected failure to the test. */
      async stop() { stoppedWhileStarting = !startFinished; events.push('gateway:stop'); },
    },
    { name: 'consumer', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('consumer:start'); }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('consumer:stop'); } },
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
    { name: 'database', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('database:start'); entered.release(); await releaseStart.promise; }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('database:stop'); } },
    { name: 'gateway', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('gateway:start'); }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('gateway:stop'); } },
  ];
  const startup = startApplication(resources);
  await entered.promise;
  resources.splice(0, resources.length, {
    name: 'replacement', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() { events.push('replacement:start'); }, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { events.push('replacement:stop'); },
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
  const first = await startApplication([{ name: 'first', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() {}, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { stopped.push('first'); } }]);
  const second = await startApplication([{ name: 'second', /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */ async start() {}, /** Simulate resource cleanup and expose its order or selected failure to the test. */ async stop() { stopped.push('second'); } }]);
  await first.shutdown();
  assert.deepEqual(stopped, ['first']);
  await second.shutdown();
  assert.deepEqual(stopped, ['first', 'second']);
  assert.deepEqual({ ...process.env }, envBefore);
  assert.deepEqual({ interrupt: process.listenerCount('SIGINT'), terminate: process.listenerCount('SIGTERM') }, signalListenersBefore);
});

test('an asynchronous fatal resource aborts shared admission and reports once before reverse cleanup', async () => {
  const failure = gate(), events: string[] = []; let runningSignal: AbortSignal | undefined;
  const app = await startApplication([
    { name: 'ownership', failure: failure.promise,
      /** Capture the application-wide signal used to fence work after ownership loss. */
      async start(signal) { runningSignal = signal; },
      /** Record reverse cleanup of the lost ownership session. */
      async stop() { events.push('ownership:stop'); } },
    { name: 'consumer',
      /** Represent a dependent consumer that has completed its startup. */
      async start() {},
      /** Record the consumer stopping before its ownership dependency. */
      async stop() { events.push('consumer:stop'); } },
  ], undefined, () => events.push('failure'));
  failure.release(); await app.failure;
  assert.equal(runningSignal?.aborted, true); assert.deepEqual(events, ['failure']);
  await Promise.all([app.shutdown(), app.shutdown()]);
  assert.deepEqual(events, ['failure', 'consumer:stop', 'ownership:stop']);
});

test('fatal loss during pending startup notifies the process before startup settles and is not a clean cancellation', async () => {
  const failure = gate(), entered = gate(), releaseStart = gate(), notified = gate();
  let stopped = 0;
  const pending = startApplication([{ name: 'ownership', failure: failure.promise,
    /** Leave startup pending until the test confirms immediate fatal notification. */
    async start(signal) { entered.release(); await releaseStart.promise; assert.equal(signal.aborted, true); },
    /** Count cleanup after the pending startup has settled. */
    async stop() { stopped++; },
  }], undefined, () => notified.release());
  const rejected = assert.rejects(pending, error => { assert.ok(error instanceof Error); assert.equal(error instanceof StartupCancelledError, false); return true; });
  await entered.promise; failure.release(); await notified.promise;
  assert.equal(stopped, 0); releaseStart.release(); await rejected; assert.equal(stopped, 1);
});

test('startup rejection reports failure before rollback waits and preserves the failed-start classification', async () => {
  const cleanupEntered = gate(), cleanupAllowed = gate(), notified = gate();
  let resourceSignal: AbortSignal | undefined, notificationCount = 0;
  const controller = new AbortController();
  const pending = startApplication([{ name: 'partially-started',
    /** Reject after capturing the shared signal, as a dependency might after allocating its connection. */
    async start(signal) { resourceSignal = signal; throw new Error('private connection details'); },
    /** Hold rollback until the test verifies that the process failure callback has already fired. */
    async stop() { cleanupEntered.release(); await cleanupAllowed.promise; },
  }], controller.signal, () => { notificationCount++; controller.abort(); notified.release(); });
  const rejected = assert.rejects(pending, error => {
    assert.ok(error instanceof Error); assert.equal(error instanceof StartupCancelledError, false);
    assert.ok(!error.message.includes('private')); return true;
  });
  await notified.promise; await cleanupEntered.promise;
  assert.equal(resourceSignal?.aborted, true); assert.equal(notificationCount, 1);
  cleanupAllowed.release(); await rejected;
});
