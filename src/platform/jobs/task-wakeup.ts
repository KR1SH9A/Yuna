/** Use PostgreSQL notifications to reduce polling latency while durable scans remain the recovery path. */
import type { EventEmitter } from 'node:events';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { RuntimeResource } from '../runtime/application.js';

export type TaskWakeupChannel = 'yuna_tasks_ready' | 'yuna_results_ready';

export interface TaskWakeup extends RuntimeResource {
  readonly revision: number;
  /** Capture revision before scanning durable state, then wait only if it has not changed. */
  wait(revision: number, signal: AbortSignal, timeoutMs?: number): Promise<void>;
}

/** The installed pg package has no public declarations; keep its required surface narrow. */
type ListenerClient = Pick<EventEmitter, 'on' | 'removeListener'> & {
  query(sql: string): Promise<unknown>;
  release(destroy: boolean): void;
};
interface ListenerPool { connect(): Promise<ListenerClient> }

const connectionTimeoutMs = 5_000;
const retryDelayMs = 1_000;
/** Consume late socket errors after connection teardown; active listener failures use the reconnect path. */
const ignoreConnectionError = () => {};

/** Race only the wait, never expose driver errors or abort reasons to callers. */
function bounded<T>(work: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    /** Settle this wait once and release its timer and cancellation listeners. */
    const finish = (accept: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      accept();
    };
    /** End the wait with a bounded diagnostic that cannot expose driver errors. */
    const cancel = () => finish(() => reject(new Error('Task notification listener unavailable')));
    // Attach rejection handling even when the signal was already aborted.
    void work.then(value => finish(() => resolve(value)), cancel);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    else if (timeoutMs !== undefined) timer = setTimeout(cancel, timeoutMs);
  });
}

/**
 * Notifications only shorten a durable scan's sleep. They never carry input, authorize a claim,
 * or replace periodic recovery. LISTEN uses a dedicated session from the existing role's pool.
 */
export function createTaskWakeup(getOrm: () => MikroORM, channel: TaskWakeupChannel): TaskWakeup {
  // Channel names become SQL identifiers; keep this runtime allowlist even for typed callers.
  if (channel !== 'yuna_tasks_ready' && channel !== 'yuna_results_ready') throw new Error('Invalid task notification channel');
  const name = channel === 'yuna_tasks_ready' ? 'task-wakeups' : 'result-wakeups';
  const controller = new AbortController();
  const waiters = new Set<() => void>();
  let revision = 0;
  let started = false;
  let running: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let removeStartupAbort: (() => void) | undefined;
  let warned = false;

  /** Advance the notification revision and release every waiter so no observed wake-up is lost. */
  function wake(): void {
    revision += 1;
    for (const resolve of [...waiters]) resolve();
  }

  /** Log listener failure once while keeping periodic durable scans available. */
  function warn(): void {
    if (!warned && !controller.signal.aborted) {
      warned = true;
      console.warn(`${name}: notification listener unavailable; periodic scans remain active.`);
    }
  }

  /** Destruction prevents a LISTEN session (or an unfinished query) reentering the general pool. */
  function destroy(client: ListenerClient): void {
    try { client.release(true); } catch { warn(); }
  }

  /** Wait for a revision change, cancellation or bounded timeout, cleaning up timers and listeners afterward. */
  function wait(expectedRevision: number, signal: AbortSignal, timeoutMs = 5_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      return Promise.reject(new Error('Invalid task notification wait timeout'));
    }
    if (revision !== expectedRevision || signal.aborted || controller.signal.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
      /** Settle this wait once and release its timer and cancellation listeners. */
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      waiters.add(finish);
      signal.addEventListener('abort', finish, { once: true });
      // Keep the latch correct even if cancellation occurs while its listener is installed.
      if (revision !== expectedRevision || signal.aborted || controller.signal.aborted) finish();
    });
  }

  /** Reconnect the dedicated LISTEN session with bounded attempts while cancellation ends recovery. */
  async function listen(firstAttemptFinished: () => void): Promise<void> {
    const signal = controller.signal;
    while (!signal.aborted) {
      const attemptDeadline = Date.now() + connectionTimeoutMs;
      let client: ListenerClient | undefined;
      let abandoned = false;
      let connectionSettled = false;
      let disconnect!: () => void;
      let disconnected = false;
      const lost = new Promise<void>(resolve => { disconnect = resolve; });
      /** Wake the connection loop when the dedicated LISTEN session is lost. */
      const onDisconnect = () => { disconnected = true; disconnect(); };
      /** Wake durable scanners only for the selected channel and a still-current live listener. */
      const onNotification = (notification: { channel?: string } | null) => {
        if (!abandoned && !disconnected && !signal.aborted && notification?.channel === channel) wake();
      };
      // Acquire outside a transaction. The worker retains its restricted database credentials.
      const acquisition = Promise.resolve().then(async () => {
        const pool = await getOrm().em.getConnection().getNativeClient() as ListenerPool;
        if (signal.aborted || abandoned) throw new Error('Task notification listener stopped');
        const acquired = await pool.connect();
        // A checked-out pg client can emit an error independently of any active query.
        acquired.on('error', ignoreConnectionError);
        if (signal.aborted || abandoned) {
          destroy(acquired);
          throw new Error('Task notification listener stopped');
        }
        client = acquired;
        return acquired;
      });
      void acquisition.then(() => { connectionSettled = true; }, () => { connectionSettled = true; });
      try {
        const acquired = await bounded(acquisition, signal, connectionTimeoutMs);
        acquired.on('error', onDisconnect);
        acquired.on('end', onDisconnect);
        acquired.on('notification', onNotification);
        const subscription = Promise.race([
          acquired.query(`LISTEN ${channel}`),
          lost.then(() => { throw new Error('Task notification listener disconnected'); }),
        ]);
        await bounded(subscription, signal, Math.max(1, attemptDeadline - Date.now()));
        if (signal.aborted || disconnected) throw new Error('Task notification listener disconnected');
        warned = false;
        // LISTEN is committed before this bump: the caller scans after subscribing, closing the
        // startup/reconnection race even if notifications were missed while disconnected.
        wake();
        firstAttemptFinished();
        await bounded(lost, signal);
        warn();
      } catch { warn(); }
      finally {
        abandoned = true;
        if (client) {
          client.removeListener('notification', onNotification);
          client.removeListener('error', onDisconnect);
          client.removeListener('end', onDisconnect);
          // Keep the inert error listener until the destroyed client is collected; late socket
          // failures must not become an unhandled EventEmitter error during shutdown.
          destroy(client);
        }
        firstAttemptFinished();
      }
      if (signal.aborted) break;
      // A pool acquisition cannot be cancelled. Do not accumulate abandoned acquisitions if a
      // pool stalls; fallback scans keep running, and any late client is destroyed above.
      if (!connectionSettled) await bounded(acquisition.then(() => {}, () => {}), signal).catch(() => {});
      if (!signal.aborted) await wait(revision, signal, retryDelayMs);
    }
  }

  return Object.freeze({
    name,
    /** Expose the wake-up revision so a scanner can detect notifications that arrived during its durable scan. */
    get revision() { return revision; },
    wait,
    /** Start one notification listener and link its lifetime to application cancellation. */
    async start(signal: AbortSignal) {
      if (started || controller.signal.aborted || signal.aborted) throw new Error('Task notification listener cannot start');
      started = true;
      /** Cancel the dedicated listener and release waiters when the application begins shutdown. */
      const abort = () => { controller.abort(); wake(); };
      signal.addEventListener('abort', abort, { once: true });
      removeStartupAbort = () => signal.removeEventListener('abort', abort);
      let ready!: () => void;
      const initial = new Promise<void>(resolve => { ready = resolve; });
      running = listen(ready);
      await initial;
      if (controller.signal.aborted) throw new Error('Task notification listener startup cancelled');
    },
    /** Abort the listener, release waiting scans and wait for its connection loop to finish. */
    stop() {
      stopping ??= (async () => {
        removeStartupAbort?.();
        controller.abort();
        wake();
        await running;
      })();
      return stopping;
    },
  });
}
