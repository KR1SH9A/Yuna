/** Run one serial consumer or maintenance operation with cancellation and optional wake-up hints. */
import { setTimeout as delay } from 'node:timers/promises';

export interface LoopWakeup {
  readonly revision: number;
  wait(revision: number, signal: AbortSignal, timeoutMs?: number): Promise<void>;
}

/**
 * Snapshot the wake revision before scanning durable state, so a commit during the scan cannot
 * be lost between the scan and sleep. Returning true drains another batch without waiting.
 * Errors always back off, even during a notification burst; the caller logs a safe fixed message.
 */
export async function runBackgroundLoop(options: {
  signal: AbortSignal;
  run: () => Promise<boolean | void>;
  onError: () => void;
  intervalMs: number;
  wakeup?: LoopWakeup;
}): Promise<void> {
  const { signal, run, onError, intervalMs, wakeup } = options;
  while (!signal.aborted) {
    const revision = wakeup?.revision ?? 0;
    try {
      if (await run()) continue;
    } catch {
      if (!signal.aborted) onError();
      await delay(Math.min(intervalMs, 1_000), undefined, { signal }).catch(() => {});
      continue;
    }
    if (signal.aborted) return;
    if (wakeup) await wakeup.wait(revision, signal, intervalMs);
    else await delay(intervalMs, undefined, { signal }).catch(() => {});
  }
}
