/** Validate role-specific startup settings; policy files contain rules/limits and environment variables contain secrets. */
import { assertDiscordId, assertNonNegativeInteger, invariant } from '../db/entity-values.js';

/** A caller-supplied snapshot; bootstrap may pass process.env, tests pass isolated maps. */
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;
export type RuntimeEnvironment = 'development' | 'test' | 'production';
type AdapterMode = 'fake' | 'live';

export type DiscordConfig = Readonly<{ mode: 'fake' }> | Readonly<{
  mode: 'live'; token: string; guildId: string; replyModel: string; jevModel?: string;
}>;
export type ProviderConfig = Readonly<{ mode: 'fake' }> | Readonly<{
  mode: 'live';
  endpoint: string;
  apiKey: string;
  model: string;
}>;

export interface BotRuntimeConfig {
  readonly role: 'bot';
  readonly environment: RuntimeEnvironment;
  readonly databaseUrl: string;
  readonly discord: DiscordConfig;
  readonly policyFile?: string;
}

export interface WorkerRuntimeConfig {
  readonly role: 'ai-worker';
  readonly environment: RuntimeEnvironment;
  readonly databaseUrl: string;
  readonly concurrency: number;
  /** Per-call ceiling; the worker must also respect the individual task's earlier deadline. */
  readonly requestTimeoutMs: number;
  readonly deepseek: ProviderConfig;
  readonly jev: ProviderConfig | Readonly<{ mode: 'disabled' }>;
}

/** Require an exact enum value; missing/empty values never silently enable a live integration. */
function readEnum<const Values extends readonly string[]>(
  env: EnvironmentVariables, name: string, values: Values, fallback?: Values[number],
): Values[number] {
  const value = env[name] ?? fallback;
  invariant(typeof value === 'string' && values.includes(value),
    `Invalid configuration: ${name} must be one of ${values.join(', ')}`);
  return value;
}

/** Credentials, model IDs and URLs must be nonempty single tokens; errors never include values. */
function readText(env: EnvironmentVariables, name: string): string {
  const value = env[name];
  invariant(typeof value === 'string' && value.length > 0 && !/[\s\p{Cc}]/u.test(value),
    `Invalid configuration: ${name} must be nonempty and contain no whitespace or control characters`);
  return value;
}

/** Validate an explicit PostgreSQL destination without connecting or retaining parser errors. */
function readDatabaseUrl(env: EnvironmentVariables, name: string): string {
  const value = readText(env, name);
  let valid = false;
  try {
    const url = new URL(value);
    valid = (url.protocol === 'postgres:' || url.protocol === 'postgresql:')
      && url.hostname.length > 0 && url.username.length > 0
      && url.pathname.length > 1 && !url.pathname.slice(1).includes('/')
      && url.hash.length === 0 && !/%(?![0-9a-f]{2})/i.test(value);
    // URL accepts some malformed escape sequences; the PostgreSQL parser must be able to decode them.
    for (const part of [url.hostname, url.username, url.password, url.pathname]) decodeURIComponent(part);
  } catch {
    // A native URL/decode error can contain credentials; do not attach it as an error cause.
    valid = false;
  }
  invariant(valid, `Invalid configuration: ${name} must be a PostgreSQL URL with user, host and database, and no fragment`);
  return value;
}

/** Parse the whole decimal string, rejecting fractions, partial numbers and unbounded work. */
function readPositiveInteger(env: EnvironmentVariables, name: string, fallback: number, maximum: number): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  invariant(/^[1-9][0-9]*$/.test(raw),
    `Invalid configuration: ${name} must be a decimal integer between 1 and ${maximum}`);
  assertNonNegativeInteger(value, name);
  invariant(value <= maximum,
    `Invalid configuration: ${name} must be a decimal integer between 1 and ${maximum}`);
  return value;
}

/** Keep fake integrations explicit and limited to development/test deployments. */
function assertModeEnvironment(mode: string, environment: RuntimeEnvironment, name: string): void {
  invariant(mode !== 'fake' || environment !== 'production',
    `Invalid configuration: ${name} cannot be fake when NODE_ENV is production`);
}

/** Construct only the selected provider's settings; fake mode never reads or retains credentials. */
function readProviderConfig(
  env: EnvironmentVariables, mode: AdapterMode, apiKeyName: string, modelName: string, endpoint: string,
): ProviderConfig {
  if (mode === 'fake') return Object.freeze({ mode });
  return Object.freeze({ mode, endpoint, apiKey: readText(env, apiKeyName), model: readText(env, modelName) });
}

/**
 * Validate bot-only settings and return an immutable snapshot. The caller owns loading the
 * environment and must pass databaseUrl to the existing ORM configuration during later startup.
 * No I/O, global mutations or provider credential reads occur here.
 */
export function loadBotConfig(env: EnvironmentVariables): BotRuntimeConfig {
  const environment = readEnum(env, 'NODE_ENV', ['development', 'test', 'production']);
  const mode = readEnum(env, 'DISCORD_MODE', ['fake', 'live']);
  assertModeEnvironment(mode, environment, 'DISCORD_MODE');
  let guildId = '';
  if (mode === 'live') {
    guildId = readText(env, 'DISCORD_GUILD_ID');
    try { assertDiscordId(guildId); } catch { throw new Error('Invalid configuration: DISCORD_GUILD_ID must be a Discord server ID'); }
  }
  const discord: DiscordConfig = mode === 'fake'
    ? Object.freeze({ mode })
    : Object.freeze({ mode, token: readText(env, 'DISCORD_BOT_TOKEN'), guildId, replyModel: readText(env, 'REPLY_MODEL'),
      ...(env.JEV_MODEL === undefined ? {} : { jevModel: readText(env, 'JEV_MODEL') }) });
  const policyFile = mode === 'live' ? env.YUNA_CONFIG_FILE : undefined;
  invariant(policyFile === undefined || (policyFile.length > 0 && policyFile.length <= 4096 && !/[\p{Cc}]/u.test(policyFile)),
    'Invalid configuration: YUNA_CONFIG_FILE must be a bounded file path');
  return Object.freeze({
    role: 'bot', environment, databaseUrl: readDatabaseUrl(env, 'BOT_DATABASE_URL'), discord,
    ...(policyFile === undefined ? {} : { policyFile }),
  });
}

/**
 * Validate worker-only settings without reading Discord credentials or opening connections.
 * Provider modes are explicit; Jev defaults to disabled until the operator configures assessment.
 * Database grants and process-level secret isolation remain deployment responsibilities.
 */
export function loadWorkerConfig(env: EnvironmentVariables): WorkerRuntimeConfig {
  const environment = readEnum(env, 'NODE_ENV', ['development', 'test', 'production']);
  const deepseekMode = readEnum(env, 'DEEPSEEK_MODE', ['fake', 'live']);
  const jevMode = readEnum(env, 'JEV_MODE', ['disabled', 'fake', 'live'], 'disabled');
  assertModeEnvironment(deepseekMode, environment, 'DEEPSEEK_MODE');
  assertModeEnvironment(jevMode, environment, 'JEV_MODE');
  return Object.freeze({
    role: 'ai-worker', environment, databaseUrl: readDatabaseUrl(env, 'WORKER_DATABASE_URL'),
    concurrency: readPositiveInteger(env, 'WORKER_CONCURRENCY', 1, 32),
    requestTimeoutMs: readPositiveInteger(env, 'PROVIDER_REQUEST_TIMEOUT_MS', 30_000, 120_000),
    deepseek: readProviderConfig(env, deepseekMode, 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL',
      'https://api.deepseek.com/chat/completions'),
    jev: jevMode === 'disabled' ? Object.freeze({ mode: jevMode })
      : readProviderConfig(env, jevMode, 'OPENROUTER_API_KEY', 'JEV_MODEL',
        'https://openrouter.ai/api/alpha/decisions'),
  });
}

/** Health probes need database access and the server identity, never Discord or provider credentials. */
export function loadHealthConfig(env: EnvironmentVariables): { role: 'bot'; databaseUrl: string; guildId: string } {
  const guildId = readText(env, 'DISCORD_GUILD_ID');
  try { assertDiscordId(guildId); } catch { throw new Error('Invalid health-check guild ID'); }
  return { role: 'bot', databaseUrl: readDatabaseUrl(env, 'BOT_DATABASE_URL'), guildId };
}
