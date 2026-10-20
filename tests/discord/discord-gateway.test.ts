import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { inspect } from 'node:util';
import { test } from '@jest/globals';
import { Client, Events, MessageType, Routes, type Message } from 'discord.js';
import { DiscordGateway, type DiscordGatewayOptions } from '../../src/discord/discord.module.js';
import { hashDiscordContent } from '../../src/discord/input-normalizer.js';
import type { DiscordReplyRequest, MessageReference, NormalizedConversationMessage } from '../../src/discord/contracts.js';

const botId = '100000000000000001';
const reference: MessageReference = {
  guildId: '100000000000000002', channelId: '100000000000000003', messageId: '100000000000000004',
};
const authorId = '100000000000000005';
const previousId = '100000000000000006';
const deliveredId = '100000000000000007';
const foreignGuild = '100000000000000008';
const secret = 'private-test-token-must-never-be-propagated';
const signal = () => new AbortController().signal;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Request = { body?: Record<string, unknown>; signal?: AbortSignal; query?: URLSearchParams };

function apiMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: reference.messageId, channel_id: reference.channelId, author: { id: authorId, bot: false },
    type: MessageType.Default, content: `<@${botId}> hello`, timestamp: '2024-01-01T00:00:00.000Z',
    edited_timestamp: null, ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}): Message {
  return {
    id: reference.messageId, guildId: reference.guildId, channelId: reference.channelId,
    author: { id: authorId, bot: false }, webhookId: null, system: false, type: MessageType.Default,
    content: `<@${botId}> hello`, createdTimestamp: Date.parse('2024-01-01T00:00:00.000Z'),
    editedTimestamp: null, reference: null,
    mentions: { users: new Set([botId]), parsedUsers: new Set([botId]) }, ...overrides,
  } as unknown as Message;
}

class FakeClient extends EventEmitter {
  user = { id: botId };
  ready = true;
  permitted = true;
  thread = false;
  archived = false;
  destroyed = 0;
  readonly guilds = { cache: new Map([[reference.guildId, { id: reference.guildId, available: true }]]) };
  readonly channels = { cache: new Map([[reference.channelId, {
    guildId: reference.guildId,
    isSendable: () => true, isThread: () => this.thread, isVoiceBased: () => false,
    get archived() { return false; }, locked: false,
    permissionsFor: () => ({ has: (_permissions: unknown) => this.permitted }),
  }]]) };
  readonly gets: { route: string; request: Request }[] = [];
  readonly posts: { route: string; request: Request }[] = [];
  getResult: (route: string, request: Request) => Promise<unknown> = async () => apiMessage();
  postResult: (route: string, request: Request) => Promise<unknown> = async (_route, request) => apiMessage({
    id: deliveredId, author: { id: botId, bot: true }, content: request.body?.content,
    message_reference: request.body?.message_reference,
  });
  readonly rest = {
    get: async (route: string, request: Request) => {
      this.gets.push({ route, request });
      return this.getResult(route, request);
    },
    post: async (route: string, request: Request) => {
      this.posts.push({ route, request });
      return this.postResult(route, request);
    },
  };
  async login(_token: string): Promise<string> { this.emit(Events.ClientReady, this); return 'unused'; }
  async destroy(): Promise<void> { this.destroyed += 1; this.ready = false; }
  isReady(): boolean { return this.ready; }
}

async function fixture(extra: Partial<DiscordGatewayOptions> = {}) {
  const client = new FakeClient();
  const messages: NormalizedConversationMessage[] = [];
  const invalidations: MessageReference[] = [];
  const unavailable: string[] = [];
  const gateway = new DiscordGateway({
    token: secret, guildId: reference.guildId,
    onMessage: input => { messages.push(input); },
    onInvalidation: input => { invalidations.push(input); },
    onUnavailable: () => { unavailable.push('unavailable'); }, ...extra,
  }, { createClient: () => client as unknown as Client });
  await gateway.start(signal());
  return { client, gateway, messages, invalidations, unavailable };
}

function reply(overrides: Partial<DiscordReplyRequest> = {}): DiscordReplyRequest {
  return { ...reference, content: 'hello @everyone <@100000000000000005>', nonce: reference.messageId,
    deadline: new Date(Date.now() + 60_000), ...overrides };
}

test('gateway admits explicit human mentions only within its configured guild', async () => {
  const { client, gateway, messages } = await fixture();
  try {
    client.emit(Events.MessageCreate, message());
    client.emit(Events.MessageCreate, message({ guildId: null }));
    client.emit(Events.MessageCreate, message({ guildId: foreignGuild }));
    client.emit(Events.MessageCreate, message({ author: { id: authorId, bot: true } }));
    client.emit(Events.MessageCreate, message({ webhookId: previousId }));
    client.emit(Events.MessageCreate, message({ system: true }));
    client.emit(Events.MessageCreate, message({ content: '@everyone hello', mentions: { users: new Set(), parsedUsers: new Set() } }));
    client.emit(Events.MessageCreate, message({ content: 'hello', mentions: { users: new Set([botId]), parsedUsers: new Set() } }));
    await setImmediate();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text, 'hello');
    assert.equal(gateway.botUserId, botId);
    assert.equal(client.gets.length, 0);
  } finally { await gateway.stop(); }
});

test('reply trigger verifies the referenced author even when the sender disabled reply pings', async () => {
  const { client, gateway, messages } = await fixture();
  const replyMessage = message({
    content: 'follow up', type: MessageType.Reply,
    reference: { guildId: reference.guildId, channelId: reference.channelId, messageId: previousId, type: 0 },
    mentions: { users: new Set(), parsedUsers: new Set() },
  });
  try {
    client.getResult = async () => apiMessage({ id: previousId, content: 'Earlier answer', author: { id: botId, bot: true } });
    client.emit(Events.MessageCreate, replyMessage);
    await setImmediate();
    assert.equal(messages[0]?.previousReply, 'Earlier answer');
    client.getResult = async () => apiMessage({ id: previousId, author: { id: authorId, bot: false } });
    client.emit(Events.MessageCreate, replyMessage);
    await setImmediate();
    client.emit(Events.MessageCreate, message({ ...replyMessage, reference: { ...replyMessage.reference, guildId: foreignGuild } }));
    await setImmediate();
    assert.equal(messages.length, 1);
    assert.equal(client.gets.length, 2);
  } finally { await gateway.stop(); }
});

test('edits and single/bulk deletes invalidate by identity without reconstructing message bodies', async () => {
  const { client, gateway, invalidations, messages } = await fixture();
  try {
    const partial = { guildId: reference.guildId, channelId: reference.channelId, id: reference.messageId };
    client.emit(Events.MessageUpdate, {}, partial);
    client.emit(Events.MessageDelete, partial);
    client.emit(Events.MessageBulkDelete, new Map([[reference.messageId, partial], [previousId, { ...partial, id: previousId }]]));
    client.emit(Events.MessageDelete, { ...partial, guildId: foreignGuild });
    await setImmediate();
    assert.deepEqual(invalidations.map(item => item.messageId), [reference.messageId, reference.messageId, reference.messageId, previousId]);
    assert.equal(messages.length, 0);
    assert.equal(client.gets.length, 0);
  } finally { await gateway.stop(); }
});

test('an edit arriving while reply verification waits prevents later create admission', async () => {
  const { client, gateway, invalidations, messages } = await fixture();
  const read = deferred<unknown>();
  client.getResult = () => read.promise;
  try {
    client.emit(Events.MessageCreate, message({
      content: 'follow up', type: MessageType.Reply,
      reference: { guildId: reference.guildId, channelId: reference.channelId, messageId: previousId, type: 0 },
      mentions: { users: new Set(), parsedUsers: new Set() },
    }));
    client.emit(Events.MessageUpdate, {}, message());
    read.resolve(apiMessage({ id: previousId, author: { id: botId, bot: true } }));
    await setImmediate();
    assert.equal(messages.length, 0);
    assert.deepEqual(invalidations, [reference]);
  } finally { await gateway.stop(); }
});

test('fresh source hash agrees with original capture and send payload disables all outbound pings', async () => {
  const { client, gateway, messages } = await fixture();
  try {
    client.emit(Events.MessageCreate, message());
    const state = await gateway.readSource(reference, signal());
    assert.equal(state.exists, true);
    assert.equal(state.canSend, true);
    assert.equal(state.sourceHash, messages[0]?.sourceHash);
    const result = await gateway.sendReply(reply({ expectedSourceHash: state.sourceHash! }), signal());
    assert.deepEqual(result, { classification: 'delivered', messageId: deliveredId });
    const sent = client.posts[0];
    assert.equal(sent?.route, Routes.channelMessages(reference.channelId));
    assert.equal(sent?.request.body?.nonce, reference.messageId);
    assert.equal(sent?.request.body?.enforce_nonce, true);
    assert.deepEqual(sent?.request.body?.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
    assert.deepEqual(sent?.request.body?.message_reference, {
      message_id: reference.messageId, channel_id: reference.channelId, guild_id: reference.guildId, fail_if_not_exists: true,
    });
    assert.ok(sent?.request.signal instanceof AbortSignal);
  } finally { await gateway.stop(); }
});

test('scope, expired deadlines, invalid nonces, permissions and changed source prevent POST', async () => {
  const { client, gateway } = await fixture();
  try {
    const outside = { ...reference, guildId: foreignGuild };
    assert.equal((await gateway.readSource(outside, signal())).exists, false);
    assert.equal((await gateway.sendReply(reply(outside), signal())).classification, 'definitive_failure');
    assert.equal(await gateway.findReply({ ...outside, contentHash: 'x', nonce: reference.messageId }, signal()), null);
    await gateway.sendReply(reply({ deadline: new Date(0) }), signal());
    await gateway.sendReply(reply({ nonce: previousId }), signal());
    assert.equal(client.gets.length, 0);
    client.permitted = false;
    await gateway.sendReply(reply(), signal());
    client.permitted = true;
    const changed = await gateway.sendReply(reply({ expectedSourceHash: 'old-source-hash' }), signal());
    assert.deepEqual(changed, { classification: 'definitive_failure', code: 'source_changed' });
    assert.equal(client.posts.length, 0);
  } finally { await gateway.stop(); }
});

test('send failures expose only static classifications and safe HTTP status', async () => {
  const { client, gateway } = await fixture();
  try {
    for (const status of [403, 500, undefined]) {
      client.postResult = async () => { throw Object.assign(new Error(secret), { status, requestBody: { token: secret }, cause: new Error(secret) }); };
      const result = await gateway.sendReply(reply(), signal());
      assert.equal(result.classification, status === 403 ? 'definitive_failure' : 'unknown');
      assert.ok(!inspect(result, { depth: null }).includes(secret));
      assert.ok(!JSON.stringify(result).includes(secret));
    }
    assert.equal(client.posts.length, 3); // One attempt per request; no automatic application retry.
  } finally { await gateway.stop(); }
});

test('nonce reuse returning a different recorded reply stays unconfirmed', async () => {
  const { client, gateway } = await fixture();
  try {
    client.postResult = async () => apiMessage({
      id: deliveredId, author: { id: botId, bot: true }, content: 'a different earlier reply',
      message_reference: { message_id: reference.messageId },
    });
    assert.deepEqual(await gateway.sendReply(reply(), signal()), { classification: 'unknown', code: 'unexpected_reply' });
    assert.equal(client.posts.length, 1);
  } finally { await gateway.stop(); }
});

test('cancelling after POST starts remains unknown and propagates abort to REST', async () => {
  const { client, gateway } = await fixture();
  const started = deferred<void>();
  const controller = new AbortController();
  client.postResult = async (_route, request) => {
    started.resolve();
    return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error(secret)), { once: true }));
  };
  try {
    const sending = gateway.sendReply(reply(), controller.signal);
    await started.promise;
    controller.abort();
    assert.deepEqual(await sending, { classification: 'unknown', code: 'delivery_unconfirmed' });
    assert.equal(client.posts.length, 1);
  } finally { await gateway.stop(); }
});

test('reconciliation requires own author, exact nonce, source reference and content hash', async () => {
  const { client, gateway } = await fixture();
  const content = 'recorded exact reply';
  const match = apiMessage({
    id: deliveredId, author: { id: botId, bot: true }, content, nonce: reference.messageId,
    message_reference: { message_id: reference.messageId, channel_id: reference.channelId, guild_id: reference.guildId },
  });
  const lookup = { ...reference, nonce: reference.messageId, contentHash: hashDiscordContent(content) };
  try {
    client.getResult = async () => [{ ...match, author: { id: authorId } }, { ...match, nonce: previousId }, { ...match, content: 'changed' }];
    assert.equal(await gateway.findReply(lookup, signal()), null);
    client.getResult = async () => [{ ...match, nonce: undefined }];
    assert.equal(await gateway.findReply(lookup, signal()), null);
    client.getResult = async () => [match];
    assert.equal(await gateway.findReply(lookup, signal()), deliveredId);
  } finally { await gateway.stop(); }
});

test('disconnect pauses intake and notifies once; resume restores intake within the guild', async () => {
  const { client, gateway, messages, unavailable } = await fixture();
  try {
    client.emit(Events.ShardDisconnect);
    client.emit(Events.ShardReconnecting);
    client.emit(Events.MessageCreate, message());
    assert.equal((await gateway.sendReply(reply(), signal())).classification, 'definitive_failure');
    await setImmediate();
    assert.equal(unavailable.length, 1);
    assert.equal(messages.length, 0);
    client.emit(Events.ShardResume);
    await setImmediate();
    client.emit(Events.MessageCreate, message());
    await setImmediate();
    assert.equal(messages.length, 1);
  } finally { await gateway.stop(); }
});

test('stop is shared, stops admission immediately and drains already running callbacks', async () => {
  const callback = deferred<void>();
  const entered = deferred<void>();
  let called = 0;
  const { client, gateway } = await fixture({ onMessage: async () => { called += 1; entered.resolve(); await callback.promise; } });
  client.emit(Events.MessageCreate, message());
  await entered.promise;
  const stopping = gateway.stop();
  assert.equal(gateway.stop(), stopping);
  let finished = false;
  void stopping.then(() => { finished = true; });
  client.emit(Events.MessageCreate, message());
  await setImmediate();
  assert.equal(finished, false);
  assert.equal(called, 1);
  callback.resolve();
  await stopping;
  assert.equal(client.destroyed, 1);
});

test('reconnect waits for cancellation of work admitted before the connection gap', async () => {
  const cancellation = deferred<void>();
  let unavailableCalls = 0;
  const { client, gateway, messages } = await fixture({ onUnavailable: async () => {
    unavailableCalls += 1;
    if (unavailableCalls === 1) await cancellation.promise;
  } });
  try {
    client.emit(Events.ShardDisconnect);
    client.emit(Events.ShardResume);
    await setImmediate();
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 0);
    cancellation.resolve();
    await setImmediate();
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 1);
  } finally { cancellation.resolve(); await gateway.stop(); }
});

test('a new disconnect cannot leave an in-flight available callback as the last persisted state', async () => {
  const resumeEntered = deferred<void>();
  const finishResume = deferred<void>();
  const transitions: string[] = [];
  let availableCalls = 0;
  const { client, gateway, messages } = await fixture({
    async onAvailable() {
      availableCalls += 1;
      if (availableCalls === 2) { resumeEntered.resolve(); await finishResume.promise; }
      transitions.push('available');
    },
    onUnavailable() { transitions.push('unavailable'); },
  });
  try {
    client.emit(Events.ShardDisconnect);
    await setImmediate();
    client.emit(Events.ShardResume);
    await resumeEntered.promise;
    client.emit(Events.ShardDisconnect);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 0);
    finishResume.resolve();
    await setImmediate();
    assert.deepEqual(transitions, ['available', 'unavailable', 'available', 'unavailable']);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 0);
    assert.equal((await gateway.sendReply(reply(), signal())).classification, 'definitive_failure');
  } finally { finishResume.resolve(); await gateway.stop(); }
});

test('startup cancellation/failure never retain token-bearing SDK errors', async () => {
  const client = new FakeClient();
  client.login = async () => { throw new Error(secret, { cause: new Error(secret) }); };
  const gateway = new DiscordGateway({ token: secret, guildId: reference.guildId, onMessage() {}, onInvalidation() {} }, {
    createClient: () => client as unknown as Client,
  });
  await assert.rejects(gateway.start(signal()), error => {
    assert.ok(error instanceof Error);
    assert.ok(!inspect(error, { depth: null }).includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
  await gateway.stop();
  const blocked = new FakeClient();
  blocked.login = () => new Promise<string>(() => {});
  const interrupted = new DiscordGateway({ token: secret, guildId: reference.guildId, onMessage() {}, onInvalidation() {} }, {
    createClient: () => blocked as unknown as Client,
  });
  const abort = new AbortController();
  const starting = interrupted.start(abort.signal);
  abort.abort();
  await assert.rejects(starting, /Discord startup/);
  await interrupted.stop();
  assert.equal(blocked.destroyed, 1);
});
