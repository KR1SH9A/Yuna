import { StartupCancelledError, type RunningApplication } from './application.js';

/**
 * Own CLI signals only. Install handlers before bootstrap so interruption during connection
 * setup rolls back too. Normal exit lets Node flush output; a stuck shutdown has a hard limit.
 * Importing this module has no effects. Call it once in a dedicated executable process.
 */
export async function runApplicationProcess(
  role: 'bot' | 'ai-worker', bootstrap: (signal: AbortSignal) => Promise<RunningApplication>,
  shutdownTimeoutMs = 10_000,
): Promise<void> {
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 2_147_483_647) {
    throw new Error('Shutdown timeout must be an integer from 1 to 2147483647 milliseconds');
  }
  const controller = new AbortController();
  let resolveShutdown!: () => void;
  const requested = new Promise<void>(resolve => { resolveShutdown = resolve; });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let failed = false;
  // Fake integrations have no active handles; keep the development host alive until a signal.
  const keepAlive = setInterval(() => {}, 60_000);

  /** Last resort when cleanup hangs or leaks handles; ordinary exits never use process.exit. */
  function forceExit(): void {
    console.error(`${role}: shutdown deadline exceeded; forcing exit.`);
    process.exit(1);
  }

  /** Latch the first signal so repeats cannot race cleanup or extend its deadline. */
  function requestShutdown(): void {
    if (controller.signal.aborted) return;
    controller.abort();
    resolveShutdown();
    deadline = setTimeout(forceExit, shutdownTimeoutMs);
  }

  process.on('SIGINT', requestShutdown);
  process.on('SIGTERM', requestShutdown);
  try {
    const app = await bootstrap(controller.signal);
    if (!controller.signal.aborted) console.info(`${role}: ready.`);
    await requested;
    await app.shutdown();
  } catch (error) {
    if (!(error instanceof StartupCancelledError && controller.signal.aborted)) {
      // Unexpected driver/adapter errors can include credentials. Never print raw errors here.
      console.error(`${role}: runtime failed; check role configuration, supported modes and database connectivity.`);
      process.exitCode = 1;
      failed = true;
      // A failed close may leave active handles. Permit natural exit, but cap any leaked handles.
      deadline ??= setTimeout(forceExit, shutdownTimeoutMs);
      deadline.unref();
    }
  } finally {
    clearInterval(keepAlive);
    if (!failed) clearTimeout(deadline);
    process.off('SIGINT', requestShutdown);
    process.off('SIGTERM', requestShutdown);
  }
}
