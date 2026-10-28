/** Explicit operator CLI for upserting only the guild-scoped /yuna command; importing this file performs no I/O. */
import { pathToFileURL } from 'node:url';
import { Routes } from 'discord.js';
import { administrationCommandDefinition } from '../../src/discord/discord.module.js';
import { assertDiscordId, invariant } from '../../src/platform/db/entity-values.js';

export interface DiscordCommandRegistrationConfig {
  readonly token: string;
  readonly guildId: string;
  readonly applicationId: string;
}
export interface DiscordCommandRegistrationResult {
  readonly commandId: string;
  readonly guildId: string;
  readonly applicationId: string;
}

/** Safe codes never retain the HTTP response, authentication header or underlying exception. */
export class DiscordCommandRegistrationError extends Error {
  /** Expose only a safe command-registration error code rather than Discord credentials or raw responses. */
  constructor(readonly code: 'invalid_configuration' | 'rejected' | 'unconfirmed' | 'invalid_response') {
    super(`Discord command registration failed (${code})`);
    this.name = 'DiscordCommandRegistrationError';
  }
}

const responseLimitBytes = 64 * 1024;
const registrationTimeoutMs = 10_000;

/** Bound response memory and cancel its reader when the whole registration deadline expires. */
async function readRegistrationResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  invariant(response.body && response.headers.get('content-type')?.toLowerCase().includes('application/json'), 'Invalid command response');
  const declaredSize = response.headers.get('content-length');
  invariant(declaredSize === null || (/^[0-9]+$/.test(declaredSize) && Number(declaredSize) <= responseLimitBytes), 'Command response exceeds bound');
  const reader = response.body.getReader();
  /** Stop reading a registration response after its deadline without exposing a raw stream error. */
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      invariant(bytes <= responseLimitBytes, 'Command response exceeds bound');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** POST-by-name updates only /yuna in the selected guild; never bulk overwrite or retry an uncertain write. */
export async function registerDiscordCommands(
  config: DiscordCommandRegistrationConfig,
  request: typeof fetch = fetch,
): Promise<DiscordCommandRegistrationResult> {
  let selected: DiscordCommandRegistrationConfig;
  try {
    assertDiscordId(config.guildId);
    assertDiscordId(config.applicationId);
    invariant(typeof config.token === 'string' && config.token.length > 0 && config.token.length <= 4_096
      && !/[\s\p{Cc}]/u.test(config.token) && typeof request === 'function', 'Invalid registration settings');
    selected = Object.freeze({ guildId: config.guildId, applicationId: config.applicationId, token: config.token });
  } catch { throw new DiscordCommandRegistrationError('invalid_configuration'); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), registrationTimeoutMs);
  let response: Response | undefined;
  try {
    response = await request(`https://discord.com/api/v10${Routes.applicationGuildCommands(selected.applicationId, selected.guildId)}`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bot ${selected.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(administrationCommandDefinition),
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new DiscordCommandRegistrationError(response.status >= 400 && response.status < 500 ? 'rejected' : 'unconfirmed');
    }
    let value: unknown;
    try { value = await readRegistrationResponse(response, controller.signal); }
    catch { throw new DiscordCommandRegistrationError(controller.signal.aborted ? 'unconfirmed' : 'invalid_response'); }
    try {
      invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid registration result');
      const command = value as Record<string, unknown>;
      assertDiscordId(command.id as string);
      invariant(command.application_id === selected.applicationId && command.guild_id === selected.guildId
        && command.name === 'yuna' && command.type === 1, 'Wrong registered command');
      return Object.freeze({ commandId: command.id as string, guildId: selected.guildId, applicationId: selected.applicationId });
    } catch { throw new DiscordCommandRegistrationError('invalid_response'); }
  } catch (error) {
    if (error instanceof DiscordCommandRegistrationError) throw error;
    throw new DiscordCommandRegistrationError('unconfirmed');
  } finally {
    clearTimeout(timer);
    controller.abort();
    await response?.body?.cancel().catch(() => {});
  }
}

// The standalone entry point reads named settings and prints safe metadata; the legacy token alias cannot override the primary token.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new DiscordCommandRegistrationError('invalid_configuration');
    const primaryToken = process.env.DISCORD_BOT_TOKEN, aliasToken = process.env.DISCORD_TOKEN;
    if (primaryToken && aliasToken && primaryToken !== aliasToken) throw new DiscordCommandRegistrationError('invalid_configuration');
    const registered = await registerDiscordCommands({
      token: primaryToken || aliasToken || '', guildId: process.env.DISCORD_GUILD_ID ?? '',
      applicationId: process.env.DISCORD_APPLICATION_ID ?? '',
    });
    console.info(`Registered /yuna in guild ${registered.guildId} (command ${registered.commandId}).`);
  } catch (error) {
    const code = error instanceof DiscordCommandRegistrationError ? error.code : 'unconfirmed';
    console.error(`Discord command registration failed (${code}). Check DISCORD_BOT_TOKEN, DISCORD_GUILD_ID and DISCORD_APPLICATION_ID; conflicting DISCORD_TOKEN aliases are rejected and uncertain outcomes are not retried.`);
    process.exitCode = 1;
  }
}
