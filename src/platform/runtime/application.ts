/** A resource allocates only in start; stop must also tolerate a partially failed start. */
export interface RuntimeResource {
  readonly name: string;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export interface RunningApplication {
  /** All callers share one cleanup operation, including its failure result. */
  shutdown(): Promise<void>;
}

/** Distinguish a cleanly rolled-back interrupted startup from a startup/cleanup failure. */
export class StartupCancelledError extends Error {
  constructor() { super('Application startup cancelled'); }
}

/**
 * Start resources in dependency order and stop them in reverse order. No process listeners,
 * database policy or business behavior live here. Resource names must be developer-owned labels.
 * Cancellation waits for the active start to settle before cleanup; the CLI bounds that wait.
 */
export async function startApplication(
  resources: readonly RuntimeResource[], signal: AbortSignal = new AbortController().signal,
): Promise<RunningApplication> {
  const planned = [...resources];
  const attempted: RuntimeResource[] = [];
  let stopping: Promise<void> | undefined;

  /** Attempt every close even after a failure; never retain credential-bearing driver errors. */
  function shutdown(): Promise<void> {
    stopping ??= Promise.resolve().then(async () => {
      const failed: string[] = [];
      for (const resource of [...attempted].reverse()) {
        try { await resource.stop(); } catch { failed.push(resource.name); }
      }
      if (failed.length) throw new Error(`Application shutdown failed: ${failed.join(', ')}`);
    });
    return stopping;
  }

  try {
    for (const resource of planned) {
      signal.throwIfAborted();
      attempted.push(resource);
      await resource.start(signal);
    }
    signal.throwIfAborted();
  } catch {
    const cancelled = signal.aborted;
    // Register before start, so a connection acquired just before rejection is still closed.
    try { await shutdown(); } catch {
      throw new Error('Application startup failed and resource cleanup failed');
    }
    if (cancelled) throw new StartupCancelledError();
    throw new Error(`Application startup failed: ${attempted.at(-1)?.name ?? 'resources'}`);
  }
  return Object.freeze({ shutdown });
}

/** Lifecycle-only development stand-in; it does not simulate messages, generation or decisions. */
export function createFakeResource(name: string): RuntimeResource {
  return Object.freeze({
    name,
    async start(signal: AbortSignal) { signal.throwIfAborted(); },
    async stop() {},
  });
}
