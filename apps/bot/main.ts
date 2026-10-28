/** Compose the bot application and allow injected dependencies for offline startup tests. */
import { loadBotConfig, type BotRuntimeConfig, type EnvironmentVariables } from '../../src/platform/config/runtime-config.js';
import { startApplication, type RunningApplication, type RuntimeResource } from '../../src/platform/runtime/application.js';
import { createBotResources } from './bot.module.js';

/** Validate before composition or I/O. Imports are inert; the separate CLI owns process signals. */
export async function bootstrap(
  env: EnvironmentVariables,
  options: { signal?: AbortSignal; onFailure?: () => void; compose?: (config: BotRuntimeConfig) => readonly RuntimeResource[] } = {},
): Promise<RunningApplication> {
  const config = loadBotConfig(env);
  return startApplication((options.compose ?? createBotResources)(config), options.signal, options.onFailure);
}
