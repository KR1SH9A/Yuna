/** Verify guild command registration through injected HTTP and isolated invalid-config CLI runs; never contact Discord. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { inspect, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { jest, test } from '@jest/globals';
import { registerDiscordCommands, DiscordCommandRegistrationError } from '../../apps/admin/register-discord-commands.js';
import { administrationCommandDefinition } from '../../src/discord/discord.module.js';

const config = { token: 'private-discord-token-never-print', guildId: '100000000000000002', applicationId: '100000000000000001' };
const commandId = '100000000000000003';
const command = { id: commandId, application_id: config.applicationId, guild_id: config.guildId, name: 'yuna', type: 1 };

/** Confirm public failures contain only fixed codes, without nested provider diagnostics. */
function safeFailure(code: DiscordCommandRegistrationError['code']) {
  return (error: unknown) => {
    assert.ok(error instanceof DiscordCommandRegistrationError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.ok(!inspect(error, { depth: null }).includes(config.token));
    return true;
  };
}

test.each([200, 201])('registration accepts HTTP %i and upserts only the single named guild command', async status => {
  const calls: { url: string; options: RequestInit }[] = [];
  /** Capture the registration request and return the fixture HTTP response. */
  const request: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return Response.json({ ...command, unexpected_secret: config.token }, { status });
  };
  const result = await registerDiscordCommands(config, request);
  assert.deepEqual(result, { commandId, guildId: config.guildId, applicationId: config.applicationId });
  assert.ok(Object.isFrozen(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `https://discord.com/api/v10/applications/${config.applicationId}/guilds/${config.guildId}/commands`);
  assert.equal(calls[0]?.options.method, 'POST');
  assert.equal(calls[0]?.options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0]?.options.body as string), administrationCommandDefinition);
  assert.ok(!Array.isArray(JSON.parse(calls[0]?.options.body as string)));
  assert.equal(new Headers(calls[0]?.options.headers).get('Authorization'), `Bot ${config.token}`);
  assert.ok(calls[0]?.options.signal instanceof AbortSignal);
  assert.ok(!JSON.stringify(result).includes(config.token));
});

test('invalid configuration is rejected before any request or token-bearing error escapes', async () => {
  let calls = 0;
  /** Capture the registration request and return the fixture HTTP response. */
  const request: typeof fetch = async () => { calls += 1; throw new Error(config.token); };
  for (const invalid of [{ ...config, guildId: 'bad' }, { ...config, applicationId: '18446744073709551616' },
    { ...config, token: '' }, { ...config, token: `${config.token}\n` }]) {
    await assert.rejects(registerDiscordCommands(invalid, request), safeFailure('invalid_configuration'));
  }
  assert.equal(calls, 0);
});

test('rejection, rate limits and ambiguous network/server failures never retry or retain provider bodies', async () => {
  for (const status of [401, 403, 429, 500, 302]) {
    let calls = 0;
    /** Capture the registration request and return the fixture HTTP response. */
    const request: typeof fetch = async () => { calls += 1; return new Response(config.token, { status }); };
    await assert.rejects(registerDiscordCommands(config, request), safeFailure(status >= 400 && status < 500 ? 'rejected' : 'unconfirmed'));
    assert.equal(calls, 1);
  }
  await assert.rejects(registerDiscordCommands(config, async () => { throw new Error(config.token, { cause: new Error(config.token) }); }), safeFailure('unconfirmed'));
});

test('response validation rejects unrelated commands, wrong scope, malformed and oversized JSON', async () => {
  const responses = [
    Response.json({ ...command, name: 'another-command' }), Response.json({ ...command, guild_id: commandId }),
    Response.json({ ...command, application_id: commandId }), Response.json({ ...command, id: 'invalid' }),
    Response.json({ ...command, type: 2 }), Response.json([command]),
    new Response('{bad', { headers: { 'Content-Type': 'application/json' } }),
    new Response('x'.repeat(65_537), { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' } }),
    new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
  ];
  for (const response of responses) await assert.rejects(registerDiscordCommands(config, async () => response), safeFailure('invalid_response'));
});

test('the request deadline aborts one pending request and leaves no retry timer', async () => {
  jest.useFakeTimers();
  try {
    let calls = 0;
    /** Capture the registration request and return the fixture HTTP response. */
    const request: typeof fetch = async (_url, options) => {
      calls += 1;
      return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error(config.token)), { once: true }));
    };
    const expected = assert.rejects(registerDiscordCommands(config, request), safeFailure('unconfirmed'));
    await jest.advanceTimersByTimeAsync(10_000);
    await expected;
    assert.equal(calls, 1);
    assert.equal(jest.getTimerCount(), 0);
  } finally { jest.useRealTimers(); }
});

test('standalone CLI refuses missing configuration and token arguments without printing secrets or making HTTP calls', async () => {
  const script = fileURLToPath(new URL('../../apps/admin/register-discord-commands.js', import.meta.url));
  for (const { args, tokens } of [
    { args: [], tokens: { DISCORD_BOT_TOKEN: '', DISCORD_TOKEN: '' } },
    { args: [config.token], tokens: { DISCORD_BOT_TOKEN: '', DISCORD_TOKEN: '' } },
    { args: [], tokens: { DISCORD_BOT_TOKEN: config.token, DISCORD_TOKEN: 'conflicting-alias' } },
  ]) {
    await assert.rejects(promisify(execFile)(process.execPath, [script, ...args], {
      env: { ...process.env, ...tokens, DISCORD_GUILD_ID: '', DISCORD_APPLICATION_ID: '' }, timeout: 5_000,
    }), (error: unknown) => {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, '');
      assert.match(failure.stderr, /invalid_configuration/);
      assert.ok(!failure.stderr.includes(config.token));
      return true;
    });
  }
});
