/** A resource allocates only in start; stop must also tolerate a partially failed start. */
export interface RuntimeResource {
  readonly name: string;
  /** Resolve when continued operation is unsafe; rejection is also treated as failure without exposing its reason. */
  readonly failure?: Promise<void>;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export interface RunningApplication {
  /** Resolves on an asynchronous resource failure; the process owner then performs bounded shutdown. */
  readonly failure?: Promise<void>;
  /** All callers share one cleanup operation, including its failure result. */
  shutdown(): Promise<void>;
}

/** Distinguish a cleanly rolled-back interrupted startup from a startup/cleanup failure. */
export class StartupCancelledError extends Error {
  /** Distinguish startup cancellation from a resource failure without retaining sensitive resource errors. */
  constructor() { super('Application startup cancelled'); }
}

/**
 * Start resources in dependency order and stop them in reverse order. No process listeners,
 * database policy or business behavior live here. Resource names must be developer-owned labels.
 * Cancellation waits for the active start to settle before cleanup; the CLI bounds that wait.
 */
export async function startApplication(
  resources: readonly RuntimeResource[], signal: AbortSignal = new AbortController().signal,
  onFailure?: () => void,
): Promise<RunningApplication> {
  const planned = [...resources];
  const attempted: RuntimeResource[] = [];
  let stopping: Promise<void> | undefined;
  const fatal = new AbortController(), resourceSignal = AbortSignal.any([signal, fatal.signal]);
  let resolveFailure!: () => void;
  const failure = new Promise<void>(resolve => { resolveFailure = resolve; });

  /** Abort admission immediately and notify the process even if an active startup has not returned yet. */
  function observeFailure(): void {
    if (stopping || fatal.signal.aborted) return;
    fatal.abort(); resolveFailure();
    try { onFailure?.(); } catch { /* The resolved failure signal remains available to the process owner. */ }
  }
  for (const resource of planned) if (resource.failure) void resource.failure.then(observeFailure, observeFailure);

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
      resourceSignal.throwIfAborted();
      attempted.push(resource);
      await resource.start(resourceSignal);
    }
    resourceSignal.throwIfAborted();
  } catch {
    const cancelled = signal.aborted && !fatal.signal.aborted;
    // A failed start may need cleanup that never settles; start the process deadline before awaiting it.
    if (!cancelled) observeFailure();
    // Register before start, so a connection acquired just before rejection is still closed.
    try { await shutdown(); } catch {
      throw new Error('Application startup failed and resource cleanup failed');
    }
    if (cancelled) throw new StartupCancelledError();
    throw new Error(`Application startup failed: ${attempted.at(-1)?.name ?? 'resources'}`);
  }
  return Object.freeze({ shutdown, failure });
}

/** Lifecycle-only development stand-in; it does not simulate messages, generation or decisions. */
export function createFakeResource(name: string): RuntimeResource {
  return Object.freeze({
    name,
    /** Honor startup cancellation for the placeholder resource without allocating an external dependency. */
    async start(signal: AbortSignal) { signal.throwIfAborted(); },
    /** Provide a no-op shutdown hook because this placeholder owns no external resources. */
    async stop() {},
  });
}
