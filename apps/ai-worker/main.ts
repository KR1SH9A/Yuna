/** Compose the worker application and its optional dependencies without starting it on import. */
import { loadWorkerConfig, type EnvironmentVariables, type WorkerRuntimeConfig } from '../../src/platform/config/runtime-config.js';
import { startApplication, type RunningApplication, type RuntimeResource } from '../../src/platform/runtime/application.js';
import { createWorkerResources } from './ai-worker.module.js';

/** Validate worker-only settings before composition. Task claims and provider calls come later. */
export async function bootstrap(
  env: EnvironmentVariables,
  options: { signal?: AbortSignal; onFailure?: () => void; compose?: (config: WorkerRuntimeConfig) => readonly RuntimeResource[] } = {},
): Promise<RunningApplication> {
  const config = loadWorkerConfig(env);
  return startApplication((options.compose ?? createWorkerResources)(config), options.signal, options.onFailure);
}
