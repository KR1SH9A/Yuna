/** Exercise listener reconnects, cancellation and wake-up races with deterministic connection fixtures. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterEach, beforeEach, jest, test } from '@jest/globals';
import { createTaskWakeup, type TaskWakeup, type TaskWakeupChannel } from '../../src/platform/jobs/task-wakeup.js';

/** Create a manually released promise so the test controls ordering instead of relying on arbitrary delays. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

class Client extends EventEmitter {
  readonly queries: string[] = [];
  readonly releases: boolean[] = [];
  execute: () => Promise<unknown> = async () => undefined;
  /** Handle the fixture listener query and simulate LISTEN or connection failure. */
  async query(sql: string): Promise<unknown> { this.queries.push(sql); return this.execute(); }
  /** Record that the dedicated fixture connection was released or destroyed. */
  release(destroy: boolean): void { this.releases.push(destroy); }
}

const resources: TaskWakeup[] = [];

/** Build the controllable connection/listener fixture and expose its observations to assertions. */
function harness(channel: TaskWakeupChannel = 'yuna_tasks_ready') {
  const clients: Array<Client | Error | Promise<Client>> = [];
  let connects = 0;
  const pool = {
    /** Open the selected fixture connection without using production environment credentials. */
    async connect(): Promise<Client> {
      connects++;
      const next = clients.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('Fixture has no listener client');
      return next;
    },
  };
  const orm = { em: { getConnection: () => ({ getNativeClient: async () => pool }) } } as unknown as MikroORM;
  const wakeup = createTaskWakeup(() => orm, channel);
  resources.push(wakeup);
  return { wakeup, clients, /** Expose the fixture connection count for reconnect assertions. */ get connects() { return connects; } };
}

beforeEach(() => { jest.useFakeTimers(); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => {
  await Promise.all(resources.splice(0).map(resource => resource.stop()));
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('startup commits LISTEN before readiness and the initial revision prompts a durable scan', async () => {
  const fixture = harness('yuna_results_ready');
  const client = new Client();
  const subscribed = deferred<void>();
  client.execute = () => subscribed.promise;
  fixture.clients.push(client);
  let ready = false;
  const starting = fixture.wakeup.start(new AbortController().signal).then(() => { ready = true; });
  await jest.advanceTimersByTimeAsync(0);
  assert.deepEqual(client.queries, ['LISTEN yuna_results_ready']);
  assert.equal(ready, false);
  assert.equal(fixture.wakeup.revision, 0);
  subscribed.resolve();
  await starting;
  assert.equal(fixture.wakeup.name, 'result-wakeups');
  assert.equal(fixture.wakeup.revision, 1);
});

test('a notification arriving during a durable scan prevents a subsequent lost wakeup', async () => {
  const fixture = harness();
  const client = new Client();
  fixture.clients.push(client);
  await fixture.wakeup.start(new AbortController().signal);
  const beforeScan = fixture.wakeup.revision;
  client.emit('notification', { channel: 'yuna_tasks_ready', payload: 'ignored-payload' });
  await fixture.wakeup.wait(beforeScan, new AbortController().signal);
  assert.equal(fixture.wakeup.revision, beforeScan + 1);
  assert.equal(jest.getTimerCount(), 0);
});

test('one notification wakes every waiting worker lane and ignores unrelated channels and payloads', async () => {
  const fixture = harness();
  const client = new Client();
  fixture.clients.push(client);
  await fixture.wakeup.start(new AbortController().signal);
  const revision = fixture.wakeup.revision;
  let resumed = 0;
  const waits = Array.from({ length: 3 }, () => fixture.wakeup.wait(revision, new AbortController().signal).then(() => { resumed++; }));
  client.emit('notification', { channel: 'unrelated' });
  client.emit('notification', null);
  await Promise.resolve();
  assert.equal(resumed, 0);
  client.emit('notification', { channel: 'yuna_tasks_ready', /** Deliver an untrusted notification payload to test that it carries no authority. */ get payload() { throw new Error('Do not read payloads'); } });
  await Promise.all(waits);
  assert.equal(resumed, 3);
  assert.equal(jest.getTimerCount(), 0);
});

test('missing notifications still trigger the default five-second durable scan', async () => {
  const fixture = harness();
  fixture.clients.push(new Client());
  await fixture.wakeup.start(new AbortController().signal);
  let resumed = false;
  const waiting = fixture.wakeup.wait(fixture.wakeup.revision, new AbortController().signal).then(() => { resumed = true; });
  await jest.advanceTimersByTimeAsync(4_999);
  assert.equal(resumed, false);
  await jest.advanceTimersByTimeAsync(1);
  await waiting;
  assert.equal(resumed, true);
});

test('failed LISTEN falls back and reconnects using a fresh dedicated client', async () => {
  const fixture = harness();
  const first = new Client();
  first.execute = async () => { throw new Error('private-database-password'); };
  const second = new Client();
  fixture.clients.push(first, second);
  await fixture.wakeup.start(new AbortController().signal);
  assert.equal(fixture.wakeup.revision, 0);
  assert.deepEqual(first.releases, [true]);
  let resumed = false;
  const waiting = fixture.wakeup.wait(0, new AbortController().signal).then(() => { resumed = true; });
  await jest.advanceTimersByTimeAsync(1_000);
  await waiting;
  assert.equal(resumed, true);
  assert.equal(fixture.connects, 2);
  assert.deepEqual(second.queries, ['LISTEN yuna_tasks_ready']);
  assert.equal(fixture.wakeup.revision, 1);
  assert.ok(jest.mocked(console.warn).mock.calls.every(args => !String(args).includes('private-')));
});

test('a dropped established listener reconnects and wakes scans without trusting missed notifications', async () => {
  for (const event of ['error', 'end']) {
    const fixture = harness();
    const first = new Client();
    const second = new Client();
    fixture.clients.push(first, second);
    await fixture.wakeup.start(new AbortController().signal);
    const revision = fixture.wakeup.revision;
    const waiting = fixture.wakeup.wait(revision, new AbortController().signal);
    first.emit(event, new Error('private-connection-details'));
    await jest.advanceTimersByTimeAsync(1_000);
    await waiting;
    assert.deepEqual(first.releases, [true]);
    assert.equal(fixture.wakeup.revision, revision + 1);
    const afterReconnect = fixture.wakeup.revision;
    first.emit('notification', { channel: 'yuna_tasks_ready' });
    assert.equal(fixture.wakeup.revision, afterReconnect);
    await fixture.wakeup.stop();
  }
});

test('individual abort and resource stop settle waits, remove timers, and destroy the session once', async () => {
  const fixture = harness();
  const client = new Client();
  fixture.clients.push(client);
  await fixture.wakeup.start(new AbortController().signal);
  const controller = new AbortController();
  const cancelled = fixture.wakeup.wait(fixture.wakeup.revision, controller.signal);
  controller.abort(new Error('private-abort-reason'));
  await cancelled;
  assert.equal(jest.getTimerCount(), 0);
  const remaining = fixture.wakeup.wait(fixture.wakeup.revision, new AbortController().signal);
  const firstStop = fixture.wakeup.stop();
  assert.equal(fixture.wakeup.stop(), firstStop);
  await Promise.all([remaining, firstStop]);
  assert.deepEqual(client.releases, [true]);
  assert.equal(jest.getTimerCount(), 0);
  // A delayed error on the destroyed client cannot become an uncaught EventEmitter exception.
  client.emit('error', new Error('late-socket-failure'));
  await fixture.wakeup.wait(fixture.wakeup.revision, new AbortController().signal);
});

test('startup cancellation drains a pending LISTEN and sanitizes its failure', async () => {
  const fixture = harness();
  const client = new Client();
  client.execute = () => new Promise(() => {});
  fixture.clients.push(client);
  const controller = new AbortController();
  const starting = fixture.wakeup.start(controller.signal);
  const rejection = assert.rejects(starting, error => error instanceof Error
    && error.message === 'Task notification listener startup cancelled' && error.cause === undefined);
  await jest.advanceTimersByTimeAsync(0);
  controller.abort(new Error('private-abort-reason'));
  await rejection;
  await fixture.wakeup.stop();
  assert.deepEqual(client.releases, [true]);
  assert.equal(jest.getTimerCount(), 0);
});

test('a hung LISTEN is bounded and the destroyed client does not block reconnect or shutdown', async () => {
  const fixture = harness();
  const first = new Client();
  first.execute = () => new Promise(() => {});
  const second = new Client();
  fixture.clients.push(first, second);
  const starting = fixture.wakeup.start(new AbortController().signal);
  await jest.advanceTimersByTimeAsync(5_000);
  await starting;
  assert.deepEqual(first.releases, [true]);
  await jest.advanceTimersByTimeAsync(1_000);
  assert.equal(fixture.wakeup.revision, 1);
  await fixture.wakeup.stop();
  assert.deepEqual(second.releases, [true]);
});

test('an unavailable pool does not prevent fallback scans or produce repeated raw-error logs', async () => {
  const fixture = harness();
  for (let attempt = 0; attempt < 8; attempt++) fixture.clients.push(new Error('private-pool-connection-string'));
  await fixture.wakeup.start(new AbortController().signal);
  let resumed = false;
  const waiting = fixture.wakeup.wait(0, new AbortController().signal).then(() => { resumed = true; });
  await jest.advanceTimersByTimeAsync(5_000);
  await waiting;
  assert.equal(resumed, true);
  assert.equal(fixture.wakeup.revision, 0);
  assert.equal(jest.mocked(console.warn).mock.calls.length, 1);
  assert.equal(jest.mocked(console.warn).mock.calls[0]?.[0], 'task-wakeups: notification listener unavailable; periodic scans remain active.');
});

test('a stalled acquisition is bounded, never multiplied, and destroys a late client after stop', async () => {
  const fixture = harness();
  const acquire = deferred<Client>();
  fixture.clients.push(acquire.promise);
  const starting = fixture.wakeup.start(new AbortController().signal);
  await jest.advanceTimersByTimeAsync(5_000);
  await starting;
  await jest.advanceTimersByTimeAsync(20_000);
  assert.equal(fixture.connects, 1);
  await fixture.wakeup.stop();
  const late = new Client();
  acquire.resolve(late);
  await jest.advanceTimersByTimeAsync(0);
  assert.deepEqual(late.releases, [true]);
  assert.deepEqual(late.queries, []);
  assert.equal(jest.getTimerCount(), 0);
});

test('a timed-out acquisition that eventually settles is discarded before a fresh subscription', async () => {
  const fixture = harness();
  const acquire = deferred<Client>();
  const next = new Client();
  fixture.clients.push(acquire.promise, next);
  const starting = fixture.wakeup.start(new AbortController().signal);
  await jest.advanceTimersByTimeAsync(5_000);
  await starting;
  const late = new Client();
  acquire.resolve(late);
  await jest.advanceTimersByTimeAsync(1_000);
  assert.deepEqual(late.releases, [true]);
  assert.deepEqual(next.queries, ['LISTEN yuna_tasks_ready']);
  assert.equal(fixture.wakeup.revision, 1);
});

test('a listener stopped before startup cannot allocate a connection', async () => {
  const fixture = harness();
  await fixture.wakeup.stop();
  await assert.rejects(fixture.wakeup.start(new AbortController().signal), /cannot start/);
  assert.equal(fixture.connects, 0);
});
