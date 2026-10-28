/** Verify current Discord reads keep exact scope, coverage, cancellation and attribution without live connections. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { Routes, type Client } from 'discord.js';
import { DiscordStateReader, type DiscordAuditReadRequest } from '../../src/discord/state-reader.js';

const guildId = '100000000000000001', userId = '100000000000000002', botId = '100000000000000003';
const reference = { guildId, channelId: '100000000000000004', messageId: '100000000000000005' };
const signal = new AbortController().signal;

/** Keep REST responses and lifecycle transitions under each test's control. */
function fixture() {
  const calls: { route: string; signal: AbortSignal; query?: URLSearchParams }[] = [];
  const shutdown = new AbortController();
  const state = { epoch: 0, available: true, content: true, permitted: true, archived: false, thread: false,
    get: async (_route: string, _signal: AbortSignal): Promise<unknown> => ({ user: { id: userId } }) };
  const client = { user: { id: botId }, options: { intents: { has: () => state.content } },
    channels: { cache: new Map([[reference.channelId, { guildId, isSendable: () => true,
      isThread: () => state.thread, isVoiceBased: () => false, permissionsFor: () => ({ has: () => state.permitted }),
      /** Model a currently archived thread independently from text visibility. */
      get archived() { return state.archived; }, locked: false }]]) },
    rest: { /** Record only scope and cancellation metadata; fake data never leaves the process. */
      async get(route: string, options: { signal: AbortSignal; query?: URLSearchParams }) {
        calls.push({ route, ...options }); return state.get(route, options.signal);
      } },
  } as unknown as Client;
  const reader = new DiscordStateReader(guildId, { getClient: () => client, getBotUserId: () => botId,
    isAvailable: () => state.available, getEpoch: () => state.epoch, shutdownSignal: shutdown.signal });
  return { reader, state, calls, shutdown };
}

/** A current REST snapshot is deliberately different from an authenticated original event. */
function message(overrides: Record<string, unknown> = {}) {
  return { id: reference.messageId, channel_id: reference.channelId, author: { id: userId, bot: false },
    type: 0, content: 'current text', timestamp: new Date().toISOString(), edited_timestamp: null, ...overrides };
}

/** Use Discord's snowflake timestamp field to create exact operation-window evidence. */
function auditFixture() {
  const at = Date.now();
  const id = ((BigInt(at) - 1_420_070_400_000n) << 22n).toString();
  const request: DiscordAuditReadRequest = { guildId, actorId: botId, targetUserId: userId, actionType: 22,
    reason: 'yuna:action:attempt', after: new Date(at - 5_000), before: new Date(at + 120_000) };
  const entry = { id, user_id: botId, target_id: userId, action_type: 22, reason: request.reason };
  return { request, entry };
}

test('ban lookup distinguishes current state from exact absence and indeterminate access', async () => {
  const f = fixture();
  assert.equal((await f.reader.readBan({ guildId, userId }, signal)).state, 'banned');
  assert.equal(f.calls[0]?.route, Routes.guildBan(guildId, userId));
  for (const [error, expected] of [
    [{ status: 404, code: 10026 }, 'not_banned'], [{ status: 404, code: 10004 }, 'unavailable'],
    [{ status: 403, code: 50013 }, 'unavailable'], [{ status: 429 }, 'unavailable'], [new Error('private-rest-body'), 'unavailable'],
  ] as const) {
    f.state.get = async () => { throw error; };
    const result = await f.reader.readBan({ guildId, userId }, signal);
    assert.equal(result.state, expected); assert.ok(!JSON.stringify(result).includes('private-rest-body'));
  }
  f.state.get = async () => ({ user: { id: botId } });
  assert.equal((await f.reader.readBan({ guildId, userId }, signal)).state, 'unavailable');
});

test('state reads reject wrong guilds, malformed references and canceled calls before REST', async () => {
  const f = fixture(), aborted = AbortSignal.abort();
  assert.equal((await f.reader.readBan({ guildId: botId, userId }, signal)).state, 'unavailable');
  assert.equal((await f.reader.readBan({ guildId, userId: 'invalid' }, signal)).state, 'unavailable');
  assert.equal((await f.reader.readBan({ guildId, userId }, aborted)).state, 'unavailable');
  assert.equal((await f.reader.readMessage({ ...reference, guildId: botId }, signal)).state, 'unavailable');
  assert.equal((await f.reader.readMessage(reference, aborted)).state, 'unavailable');
  assert.equal(f.calls.length, 0);
});

test('message reads preserve current text and edits without claiming original evidence', async () => {
  const f = fixture();
  f.state.get = async () => message();
  const first = await f.reader.readMessage(reference, signal);
  assert.equal(first.state, 'present'); assert.equal(first.contentAccess, 'available'); assert.equal(first.canSend, true);
  assert.equal(first.source?.content, 'current text'); assert.match(first.sourceHash!, /^[a-f0-9]{64}$/);
  f.state.get = async () => message({ content: 'edited text', edited_timestamp: new Date().toISOString() });
  const edited = await f.reader.readMessage(reference, signal);
  assert.notEqual(edited.sourceHash, first.sourceHash);
  assert.equal(edited.source?.content, 'edited text');
  f.state.permitted = false;
  assert.equal((await f.reader.readMessage(reference, signal)).canSend, false);
  f.state.permitted = true; f.state.thread = true; f.state.archived = true;
  assert.equal((await f.reader.readMessage(reference, signal)).canSend, false);
});

test('restricted, missing and malformed message reads cannot authorize publication', async () => {
  const f = fixture(); f.state.get = async () => message(); f.state.content = false;
  const restricted = await f.reader.readMessage(reference, signal);
  assert.equal(restricted.state, 'present'); assert.equal(restricted.contentAccess, 'restricted');
  assert.equal(restricted.source, null); assert.equal(restricted.sourceHash, null); assert.equal(restricted.canSend, false);
  f.state.content = true;
  for (const change of [{ id: botId }, { channel_id: guildId }, { timestamp: 'invalid' }, { edited_timestamp: 'invalid' }, { author: { id: 'invalid' } }]) {
    f.state.get = async () => message(change);
    assert.equal((await f.reader.readMessage(reference, signal)).state, 'unavailable');
  }
  for (const [code, state] of [[10008, 'missing'], [10003, 'unavailable']] as const) {
    f.state.get = async () => { throw { status: 404, code }; };
    assert.equal((await f.reader.readMessage(reference, signal)).state, state);
  }
});

test('a disconnect and reconnect during a read invalidate both presence and absence', async () => {
  for (const absent of [false, true]) {
    const f = fixture();
    f.state.get = async () => { f.state.epoch++; if (absent) throw { status: 404, code: 10026 }; return { user: { id: userId } }; };
    assert.equal((await f.reader.readBan({ guildId, userId }, signal)).state, 'unavailable');
    f.state.get = async () => { f.state.epoch++; return message(); };
    assert.equal((await f.reader.readMessage(reference, signal)).state, 'unavailable');
  }
});

test('shutdown aborts pending state reads and ban scope cannot be changed during I/O', async () => {
  const f = fixture(), input = { guildId, userId };
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.state.get = async (_route, stop) => new Promise((_resolve, reject) => {
    entered(); stop.addEventListener('abort', () => reject(new Error('shutdown')), { once: true });
  });
  const pending = f.reader.readBan(input, signal);
  await started; input.userId = botId; f.shutdown.abort();
  const result = await pending;
  assert.equal(result.userId, userId); assert.equal(result.state, 'unavailable');
  assert.equal(f.calls[0]?.signal.aborted, true);
});

test('bounded audit reads return only exact attribution and preserve empty-evidence uncertainty', async () => {
  const f = fixture(), { request, entry } = auditFixture();
  f.state.get = async () => ({ audit_log_entries: [entry, { ...entry, user_id: userId }, { ...entry, target_id: botId },
    { ...entry, action_type: 23 }, { ...entry, reason: 'another attempt' }, { ...entry, id: guildId }] });
  const read = await f.reader.readRelevantAuditEntries(request, signal);
  assert.equal(read.available, true); assert.deepEqual(read.entries.map(value => value.id), [entry.id]);
  assert.equal(f.calls[0]?.query?.get('limit'), '100'); assert.equal(f.calls[0]?.query?.get('user_id'), botId);
  f.state.get = async () => ({ audit_log_entries: [] });
  assert.deepEqual((await f.reader.readRelevantAuditEntries(request, signal)).entries, []);
  f.state.get = async () => { throw { status: 403 }; };
  assert.equal((await f.reader.readRelevantAuditEntries(request, signal)).available, false);
});

test('audit reads reject overbroad scopes, oversized pages, malformed and stale evidence', async () => {
  const f = fixture(), { request, entry } = auditFixture();
  assert.equal((await f.reader.readRelevantAuditEntries({ ...request, before: new Date(request.after.getTime() + 126_000) }, signal)).available, false);
  assert.equal(f.calls.length, 0);
  for (const entries of [new Array(101).fill(entry), [null], [{ ...entry, id: 'invalid' }]]) {
    f.state.get = async () => ({ audit_log_entries: entries });
    assert.equal((await f.reader.readRelevantAuditEntries(request, signal)).available, false);
  }
  f.state.get = async () => { f.state.epoch++; return { audit_log_entries: [entry] }; };
  assert.equal((await f.reader.readRelevantAuditEntries(request, signal)).available, false);
});
