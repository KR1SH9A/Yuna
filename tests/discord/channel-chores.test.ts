/** Verify explicit grammar and native admin-only channel effects using real state reads and fake Discord REST. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from '@jest/globals';
import { PermissionFlagsBits, Routes, type Client } from 'discord.js';
import { DiscordStateReader } from '../../src/discord/state-reader.js';
import { DiscordChannelChoreTransport } from '../../src/discord/channel-chore-transport.js';
import { parseChannelChore, validateChannelChore, type ChannelChoreOperation } from '../../src/discord/channel-chore.contracts.js';
import { normalizeConversationMessage } from '../../src/discord/input-normalizer.js';

const guildId = '100000000000000001', actorId = '100000000000000002', botId = '100000000000000003';
const channelId = '100000000000000004', messageId = '100000000000000005', roleId = '100000000000000006', botRole = '100000000000000007';
const signal = new AbortController().signal;
const create: ChannelChoreOperation = { kind: 'create', channelType: 2, name: 'Gaming' };

/** All membership, source and write responses are controllable without opening a live connection. */
async function fixture(content = 'Yuna create a voice channel Gaming') {
  const state = { permissions: 8n, botPermissions: PermissionFlagsBits.ManageChannels, ownerId: '100000000000000009',
    authorId: actorId, authorBot: false, webhook: undefined as string | undefined, content,
    available: true, error: null as unknown, log: [] as unknown[], channels: [{ id: channelId, guild_id: guildId, type: 0, name: 'general', topic: 'old', rate_limit_per_user: 0 }] };
  const writes: { method: string; route: string; body: Record<string, unknown>; reason: string }[] = [];
  const client = { user: { id: botId }, options: { intents: { has: () => true } }, channels: { cache: new Map([[channelId,
    { guildId, isSendable: () => true, isThread: () => false, isVoiceBased: () => false, permissionsFor: () => ({ has: () => true }) }]]) },
    rest: {
      /** Supply fresh API identities and permissions instead of trusting role names or cached member flags. */
      async get(route: string) {
        if (route === Routes.guild(guildId)) return { id: guildId, owner_id: state.ownerId };
        if (route === Routes.guildRoles(guildId)) return [{ id: guildId, position: 0, permissions: '0' },
          { id: roleId, name: 'Admin', position: 1, permissions: String(state.permissions) }, { id: botRole, position: 2, permissions: String(state.botPermissions) }];
        if (route === Routes.guildMember(guildId, actorId)) return { user: { id: actorId }, roles: [roleId] };
        if (route === Routes.guildMember(guildId, botId)) return { user: { id: botId }, roles: [botRole] };
        if (route === Routes.channelMessage(channelId, messageId)) return { id: messageId, channel_id: channelId, type: 0,
          author: { id: state.authorId, bot: state.authorBot }, webhook_id: state.webhook,
          content: state.content, timestamp: '2026-10-29T00:00:00.000Z', edited_timestamp: null };
        if (route === Routes.guildChannels(guildId)) return state.channels;
        if (route === Routes.guildAuditLog(guildId)) return { audit_log_entries: state.log };
        throw new Error('Unexpected route');
      },
      /** Capture exactly one channel creation attempt, including its attributable audit reason. */
      async post(route: string, options: { body: Record<string, unknown>; reason: string }) {
        writes.push({ method: 'POST', route, body: options.body, reason: options.reason }); if (state.error) throw state.error;
        return { id: '100000000000000010', guild_id: guildId, ...options.body };
      },
      /** Capture only the selected mutable field, never permission overwrites or another channel. */
      async patch(route: string, options: { body: Record<string, unknown>; reason: string }) {
        writes.push({ method: 'PATCH', route, body: options.body, reason: options.reason }); if (state.error) throw state.error;
        return { ...state.channels[0], ...options.body };
      },
    },
  } as unknown as Client;
  const reader = new DiscordStateReader(guildId, { getClient: () => client, getBotUserId: () => botId,
    isAvailable: () => state.available, getEpoch: () => 0, shutdownSignal: signal });
  const source = await reader.readMessage({ guildId, channelId, messageId }, signal);
  assert.ok(source.sourceHash);
  return { state, writes, caller: { guildId, channelId, messageId, actorId, sourceHash: source.sourceHash },
    transport: new DiscordChannelChoreTransport(() => client, reader, () => state.available, signal) };
}

test('single explicit natural chores parse; quotes, reports, chained requests and unsupported fields cannot execute', () => {
  assert.deepEqual(parseChannelChore('Yuna, could you please create a voice channel "Game Room"?'), { kind: 'create', channelType: 2, name: 'Game Room' });
  assert.deepEqual(parseChannelChore('create a channel news, Yuna'), { kind: 'create', channelType: 0, name: 'news' });
  assert.deepEqual(parseChannelChore('Yuna rename <#100000000000000004> to chat'), { kind: 'rename', channel: channelId, name: 'chat' });
  assert.deepEqual(parseChannelChore('Yuna set slowmode in #general to 2 minutes'), { kind: 'slowmode', channel: 'general', seconds: 120 });
  assert.deepEqual(parseChannelChore('Yuna set topic of #general to "Welcome"'), { kind: 'topic', channel: 'general', topic: 'Welcome' });
  assert.deepEqual(parseChannelChore('Yuna set voice limit of "Game Room" to 0'), { kind: 'voice_limit', channel: 'Game Room', limit: 0 });
  for (const text of ['> Yuna create a vc Gaming', 'He said Yuna create a vc Gaming', '`Yuna create a vc Gaming`',
    'Yuna create a vc Gaming and delete general', 'Yuna create a vc Gaming\ncreate a vc Other', 'Yuna create a vc G\u200baming',
    'Yuna give @someone administrator', 'Yuna delete all channels', 'yes', 'Yuna set slowmode in general to 99999 seconds']) assert.equal(parseChannelChore(text), null, text);
  assert.throws(() => validateChannelChore({ ...create, permission_overwrites: [] } as never));
});

test('conversational framing accepts complete chores without stripping argument names or turning quoted discussion into commands', () => {
  for (const text of [
    'okay yuna, create a channel named "Minecraft by Yuna"',
    'OK, Yuna, please create a channel named "Minecraft by Yuna"!',
    'hey Yuna, can you create a channel named "Minecraft by Yuna"?',
    'Yuna, please could you create a channel named "Minecraft by Yuna"?',
    'could you, Yuna, create a channel named "Minecraft by Yuna", please?',
    'create a channel named "Minecraft by Yuna", please, Yuna.',
    'okay, create a channel named "Minecraft by Yuna"',
    ', create a channel named "Minecraft by Yuna"',
  ]) assert.deepEqual(parseChannelChore(text), { kind: 'create', channelType: 0, name: 'Minecraft by Yuna' }, text);
  for (const name of ['Yuna', 'please', 'okay']) assert.deepEqual(parseChannelChore(`Yuna create a vc ${name}`), { kind: 'create', channelType: 2, name });
  assert.deepEqual(parseChannelChore('hey Yuna, rename #general to lounge, please'), { kind: 'rename', channel: 'general', name: 'lounge' });
  assert.deepEqual(parseChannelChore('okay Yuna, set topic of #general to "okay, Yuna, please"'), { kind: 'topic', channel: 'general', topic: 'okay, Yuna, please' });
  for (const text of ['okay Yuna, do not create a channel Minecraft', 'okay Yuna, if I ask you to create a channel Minecraft',
    'okay Yuna, he said create a channel Minecraft', 'okay Yuna, "create a channel Minecraft"',
    'okay Yuna, create a channel Minecraft and rename general to games', '> okay Yuna, create a channel Minecraft',
    'okay Yuna, yes', 'yes', 'okay Yuna']) assert.equal(parseChannelChore(text), null, text);
});

test('the screenshot request reaches one real channel-create payload after normalization and native admin checks', async () => {
  const content = 'okay yuna, create a channel named "Minecraft by Yuna"';
  for (const allowed of [true, false]) {
    const f = await fixture(content); f.state.permissions = allowed ? 8n : PermissionFlagsBits.ManageChannels;
    const input = normalizeConversationMessage({ guildId, channelId, messageId, authorId: actorId, authorIsBot: false,
      system: false, content, createdTimestamp: Date.parse('2026-10-29T00:00:00.000Z'), editedTimestamp: null,
      reference: null, directlyMentionsBot: false }, botId);
    assert.ok(input); assert.equal(input.sourceHash, f.caller.sourceHash);
    const request = parseChannelChore(input.text); assert.ok(request);
    const operation = await f.transport.prepare(f.caller, request, signal);
    if (allowed) {
      assert.ok(operation);
      assert.equal((await f.transport.execute(f.caller, operation, randomUUID(), signal, async () => true)).state, 'CONFIRMED');
      assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0]!.body, { name: 'minecraft-by-yuna', type: 0 });
    } else { assert.equal(operation, null); assert.equal(f.writes.length, 0); }
  }
});

test('only native Administrator or owner can prepare; Manage Guild/Channels and an Admin role name are insufficient', async () => {
  const f = await fixture();
  assert.deepEqual(await f.transport.prepare(f.caller, create, signal), create);
  for (const permissions of [0n, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels]) {
    f.state.permissions = permissions; assert.equal(await f.transport.prepare(f.caller, create, signal), null);
  }
  f.state.ownerId = actorId;
  assert.deepEqual(await f.transport.prepare(f.caller, create, signal), create);
  f.state.botPermissions = 0n;
  assert.equal(await f.transport.prepare(f.caller, create, signal), null);
  assert.equal(f.writes.length, 0);
});

test('execution rechecks revoked admin, changed source, human author and the local write gate', async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => { f.state.permissions = PermissionFlagsBits.ManageChannels; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.state.content += ' changed'; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.state.authorId = botId; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.state.authorBot = true; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.state.webhook = botId; },
  ]) {
    const f = await fixture(); await f.transport.prepare(f.caller, create, signal); mutate(f);
    assert.equal((await f.transport.execute(f.caller, create, randomUUID(), signal, async () => true)).state, 'FAILED');
    assert.equal(f.writes.length, 0);
  }
  const f = await fixture();
  assert.equal((await f.transport.execute(f.caller, create, randomUUID(), signal, async () => false)).state, 'FAILED');
  assert.equal(f.writes.length, 0);
});

test('exact target edits verify the old field and create/write bodies contain only allowlisted values', async () => {
  const f = await fixture(), id = randomUUID();
  const operation = await f.transport.prepare(f.caller, { kind: 'topic', channel: 'general', topic: 'Welcome' }, signal);
  assert.ok(operation);
  assert.equal((await f.transport.execute(f.caller, operation, id, signal, async () => true)).state, 'CONFIRMED');
  assert.deepEqual(f.writes[0], { method: 'PATCH', route: Routes.channel(channelId), body: { topic: 'Welcome' }, reason: `yuna:channel-chore:${id}` });
  f.state.channels[0]!.topic = 'changed';
  assert.equal((await f.transport.execute(f.caller, operation, randomUUID(), signal, async () => true)).state, 'FAILED');
  assert.equal(f.writes.length, 1);
  f.state.channels.push({ ...f.state.channels[0]!, id: botId });
  assert.equal(await f.transport.prepare(f.caller, { kind: 'rename', channel: 'general', name: 'chat' }, signal), null);
  assert.equal((await f.transport.execute(f.caller, create, randomUUID(), signal, async () => true)).state, 'CONFIRMED');
  assert.deepEqual(f.writes[1]!.body, { name: 'Gaming', type: 2 });
  assert.deepEqual(await f.transport.prepare(f.caller, { kind: 'create', channelType: 0, name: 'Game News' }, signal),
    { kind: 'create', channelType: 0, name: 'game-news' });
});

test('uncertain writes get no transport retry; reconciliation requires exact bot/reason/type/time evidence', async () => {
  const f = await fixture(), id = randomUUID(), at = new Date(); f.state.error = new Error('lost response');
  assert.equal((await f.transport.execute(f.caller, create, id, signal, async () => true)).state, 'UNKNOWN');
  assert.equal(f.writes.length, 1);
  const entry = { id: ((BigInt(at.getTime()) - 1420070400000n) << 22n).toString(), user_id: botId, target_id: channelId,
    action_type: 10, reason: `yuna:channel-chore:${id}` };
  f.state.log = [entry]; assert.equal(await f.transport.reconcile(guildId, create, id, at, signal), channelId);
  for (const change of [{ user_id: actorId }, { reason: 'someone-else' }, { action_type: 11 }, { id: '100000000000000001' }]) {
    f.state.log = [{ ...entry, ...change }]; assert.equal(await f.transport.reconcile(guildId, create, id, at, signal), null);
  }
  f.state.log = []; assert.equal(await f.transport.reconcile(guildId, create, id, at, signal), null);
});

test('moves and category creation use only parent_id and recheck the exact destination', async () => {
  const f = await fixture(), categoryId = '100000000000000088';
  f.state.channels.push({ id: categoryId, guild_id: guildId, name: 'Voice Channels', type: 4, topic: '', rate_limit_per_user: 0 });
  const operation = await f.transport.prepare(f.caller, { kind: 'move', channel: channelId, parentId: categoryId }, signal);
  assert.ok(operation);
  assert.equal((await f.transport.execute(f.caller, operation, randomUUID(), signal, async () => true)).state, 'CONFIRMED');
  assert.deepEqual(f.writes[0]!.body, { parent_id: categoryId });
  const creation = await f.transport.prepare(f.caller, { ...create, parentId: categoryId }, signal); assert.ok(creation);
  assert.equal((await f.transport.execute(f.caller, creation, randomUUID(), signal, async () => true)).state, 'CONFIRMED');
  assert.deepEqual(f.writes[1]!.body, { type: 2, name: 'Gaming', parent_id: categoryId });
  f.state.channels.pop();
  assert.equal((await f.transport.execute(f.caller, operation, randomUUID(), signal, async () => true)).state, 'FAILED');
  assert.equal(f.writes.length, 2);
  assert.throws(() => validateChannelChore({ kind: 'modify', channelId, channelType: 4, field: 'parent_id', value: categoryId, previous: null }));
});

test('planning directory is unavailable to non-admins and omits channels without verified audience visibility', async () => {
  const f = await fixture();
  f.state.channels.push({ ...f.state.channels[0]!, id: '100000000000000088', name: 'private-staff' });
  assert.deepEqual((await f.transport.readPlanningChannels(f.caller, signal))?.channels.map(c => c.name), ['general']);
  f.state.permissions = PermissionFlagsBits.ManageChannels;
  assert.equal(await f.transport.readPlanningChannels(f.caller, signal), null);
});
