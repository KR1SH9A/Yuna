/** Verify fresh publication access, one-shot dispatch and exact reconciliation without connecting to Discord. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from '@jest/globals';
import { PermissionFlagsBits, Routes, type Client } from 'discord.js';
import { DiscordDebateTransport, type DiscordDebatePublication } from '../../src/discord/debate-transport.js';

const guildId = '900000000000000001', channelId = '900000000000000002', botId = '900000000000000003', roleId = '900000000000000004';
/** Use the same exact hash algorithm as the owner when binding a retained summary. */
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
/** Create one valid committed publication with a unique evaluation-derived nonce. */
function publication(): DiscordDebatePublication {
  const evaluationId = randomUUID(), content = 'Debate result @everyone';
  return { guildId, channelId, evaluationId, content, contentHash: hash(content), nonce: hash(`debate:${evaluationId}`).slice(0, 24), deadline: new Date(Date.now() + 30000) };
}
/** Return a Discord message attributable to this exact publication. */
function message(request: DiscordDebatePublication, changes: Record<string, unknown> = {}) {
  return { id: '900000000000000005', channel_id: channelId, author: { id: botId }, type: 0, nonce: request.nonce, content: request.content, ...changes };
}
/** Expose only a REST-shaped fake so permission caches and real gateway connections cannot influence these tests. */
function fixture() {
  const calls: { method: string; route: string; options: { body?: Record<string, unknown> } }[] = [];
  const state = { permissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory,
    overwrites: [] as Record<string, unknown>[], channelGuildId: guildId, channelType: 0, timedOut: null as string | null,
    error: null as unknown, readError: null as unknown, history: [] as unknown[], result: null as unknown, available: true };
  const client = { rest: {
    /** Return current simulated roles, membership and destination, recording every fresh REST read. */
    async get(route: string, options: Record<string, unknown>) {
      calls.push({ method: 'GET', route, options });
      if (state.readError) throw state.readError;
      if (route === Routes.guild(guildId)) return { id: guildId, owner_id: '900000000000000009' };
      if (route === Routes.guildRoles(guildId)) return [{ id: guildId, permissions: '0' }, { id: roleId, permissions: state.permissions.toString() }];
      if (route === Routes.guildMember(guildId, botId)) return { user: { id: botId }, roles: [roleId], communication_disabled_until: state.timedOut };
      if (route === Routes.channel(channelId)) return { id: channelId, guild_id: state.channelGuildId, type: state.channelType, permission_overwrites: state.overwrites };
      if (route === Routes.channelMessages(channelId)) return state.history;
      throw new Error('Unexpected REST read');
    },
    /** Record a single effect attempt and return only the configured attributable response or failure. */
    async post(route: string, options: { body?: Record<string, unknown> }) { calls.push({ method: 'POST', route, options }); if (state.error) throw state.error; return state.result; },
  } };
  const abort = new AbortController();
  return { state, calls, abort, transport: new DiscordDebateTransport(guildId, () => client as unknown as Client, () => botId, () => state.available, abort.signal) };
}

test('publication preparation reads fresh roles and applies everyone, role and member overwrites', async () => {
  const f = fixture(), signal = new AbortController().signal;
  assert.equal((await f.transport.prepare({ guildId, channelId }, signal)).allowed, true);
  assert.equal(f.calls.length, 4);
  f.state.overwrites = [{ id: guildId, type: 0, deny: PermissionFlagsBits.SendMessages.toString(), allow: '0' }];
  assert.equal((await f.transport.prepare({ guildId, channelId }, signal)).allowed, false);
  f.state.overwrites.push({ id: roleId, type: 0, deny: '0', allow: PermissionFlagsBits.SendMessages.toString() });
  assert.equal((await f.transport.prepare({ guildId, channelId }, signal)).allowed, true);
  f.state.overwrites.push({ id: botId, type: 1, deny: PermissionFlagsBits.SendMessages.toString(), allow: '0' });
  assert.equal((await f.transport.prepare({ guildId, channelId }, signal)).allowed, false);
  f.state.permissions = PermissionFlagsBits.Administrator;
  assert.equal((await f.transport.prepare({ guildId, channelId }, signal)).allowed, true);
});

test('cross-guild, unsupported thread and timed-out destinations never become available', async () => {
  const f = fixture(), signal = new AbortController().signal;
  assert.equal((await f.transport.prepare({ guildId: '9', channelId }, signal)).allowed, false); assert.equal(f.calls.length, 0);
  f.state.channelGuildId = '9'; assert.equal((await f.transport.prepare({ guildId, channelId }, signal)).allowed, false);
  f.state.channelGuildId = guildId; f.state.channelType = 11; assert.equal((await f.transport.prepare({ guildId, channelId }, signal)).allowed, false);
  f.state.channelType = 0; f.state.timedOut = new Date(Date.now() + 60000).toISOString();
  assert.equal((await f.transport.prepare({ guildId, channelId }, signal)).allowed, false);
});

test('one confirmed POST suppresses all mentions and uses the committed nonce and exact content', async () => {
  const f = fixture(), input = publication(); f.state.result = message(input);
  assert.deepEqual(await f.transport.send(input, new AbortController().signal), { classification: 'confirmed', messageId: '900000000000000005' });
  const posts = f.calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 1);
  assert.deepEqual(posts[0]!.options.body?.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
  assert.equal(posts[0]!.options.body?.nonce, input.nonce); assert.equal(posts[0]!.options.body?.enforce_nonce, true);
});

test('invalid or expired publication is rejected before any REST call', async () => {
  const f = fixture(), input = publication(), signal = new AbortController().signal;
  for (const changed of [{ content: 'changed' }, { nonce: 'guessed' }, { deadline: new Date(0) }, { guildId: '9' }]) {
    assert.equal((await f.transport.send({ ...input, ...changed }, signal)).classification, 'rejected');
  }
  assert.equal(f.calls.length, 0);
});

test('a lost response or server error stays unknown while an observed forbidden response is definitive', async () => {
  for (const [error, classification] of [[new Error('timeout'), 'unknown'], [{ status: 500 }, 'unknown'], [{ status: 408 }, 'unknown'], [{ status: 403 }, 'rejected']] as const) {
    const f = fixture(); f.state.error = error;
    assert.equal((await f.transport.send(publication(), new AbortController().signal)).classification, classification);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('response mismatches and permission loss before the send cannot be called confirmed', async () => {
  const f = fixture(), input = publication(); f.state.result = message(input, { nonce: 'other' });
  assert.equal((await f.transport.send(input, new AbortController().signal)).classification, 'unknown');
  f.state.permissions = PermissionFlagsBits.ViewChannel;
  assert.equal((await f.transport.send(input, new AbortController().signal)).classification, 'rejected');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('reconciliation requires exactly one own nonce/hash match and does not require send permission', async () => {
  const f = fixture(), input = publication(), signal = new AbortController().signal;
  f.state.permissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
  for (const changed of [{ author: { id: '9' } }, { channel_id: '9' }, { content: 'changed' }, { nonce: 'other' }, { webhook_id: '9' }, { type: 19 }]) {
    f.state.history = [message(input, changed)]; assert.equal(await f.transport.reconcile(input, signal), null);
  }
  f.state.history = [message(input)]; assert.equal(await f.transport.reconcile(input, signal), '900000000000000005');
  f.state.history.push(message(input, { id: '900000000000000006' })); assert.equal(await f.transport.reconcile(input, signal), null);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('shutdown prevents preparation, dispatch and reconciliation without sending anything', async () => {
  const f = fixture(), input = publication(), signal = new AbortController().signal; f.abort.abort();
  await assert.rejects(f.transport.prepare(input, signal), /could not be observed/);
  assert.equal((await f.transport.send(input, signal)).classification, 'rejected');
  assert.equal(await f.transport.reconcile(input, signal), null); assert.equal(f.calls.length, 0);
});

test('a failed pre-claim read defers publication instead of reporting a permission denial', async () => {
  const f = fixture(), input = publication(), signal = new AbortController().signal;
  f.state.readError = new Error('private-token-raw-discord-error');
  await assert.rejects(f.transport.prepare(input, signal), error => error instanceof Error
    && error.message === 'Publication access could not be observed' && !String(error).includes('private-token'));
  assert.deepEqual(await f.transport.send(input, signal), { classification: 'rejected', code: 'publication_preflight_unavailable' });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  f.state.readError = null;
  assert.equal((await f.transport.prepare(input, signal)).allowed, true);
});
