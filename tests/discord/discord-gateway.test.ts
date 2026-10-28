/** Verify Discord boundaries and failure recovery without opening a Gateway or REST connection. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { inspect } from 'node:util';
import { jest, test } from '@jest/globals';
import { Client, Events, MessageFlags, MessageType, Routes, type Message } from 'discord.js';
import { administrationCommandDefinition, DiscordGateway, type DiscordGatewayOptions } from '../../src/discord/discord.module.js';
import { hashDiscordContent } from '../../src/discord/input-normalizer.js';
import type { DiscordOriginalMessageCapture, DiscordOriginalMessageProvenance, DiscordReplyRequest, MessageReference, NormalizedAdministrationCommand, NormalizedConversationMessage } from '../../src/discord/contracts.js';

const botId = '100000000000000001';
const reference: MessageReference = {
  guildId: '100000000000000002', channelId: '100000000000000003', messageId: '100000000000000004',
};
const authorId = '100000000000000005';
const previousId = '100000000000000006';
const deliveredId = '100000000000000007';
const foreignGuild = '100000000000000008';
const secret = 'private-test-token-must-never-be-propagated';
/** Create a fresh uncanceled signal so one test cannot abort another. */
const signal = () => new AbortController().signal;

/** Create a manually released promise so the test controls ordering instead of relying on arbitrary delays. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Request = { body?: Record<string, unknown>; signal?: AbortSignal; query?: URLSearchParams };

/** Build a raw Discord API message fixture with the fields required by normalization. */
function apiMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: reference.messageId, channel_id: reference.channelId, author: { id: authorId, bot: false },
    type: MessageType.Default, content: `<@${botId}> hello`, timestamp: '2024-01-01T00:00:00.000Z',
    edited_timestamp: null, ...overrides,
  };
}

/** Build the next fixture message with a distinct identity and controlled content. */
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
  application = { id: botId };
  contentIntent = true;
  readonly options = { intents: { has: () => this.contentIntent } };
  ready = true;
  permitted = true;
  thread = false;
  archived = false;
  destroyed = 0;
  readonly guilds = { cache: new Map([[reference.guildId, { id: reference.guildId, available: true }]]) };
  readonly channels = { cache: new Map([[reference.channelId, {
    guildId: reference.guildId,
    isSendable: () => true, isThread: () => this.thread, isVoiceBased: () => false,
    /** Expose the fixture channel archive state used by the permission checks. */
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
  /** Simulate gateway login without contacting Discord. */
  async login(_token: string): Promise<string> { this.emit(Events.ClientReady, this); return 'unused'; }
  /** Record fixture shutdown and close its simulated gateway state. */
  async destroy(): Promise<void> { this.destroyed += 1; this.ready = false; }
  /** Expose the fixture gateway readiness used by availability recovery. */
  isReady(): boolean { return this.ready; }
}

/** Track private acknowledgement and response calls while keeping a token-bearing SDK-like object local. */
function commandInteraction(overrides: Record<string, unknown> = {}) {
  const acknowledgments: unknown[] = [], edits: unknown[] = [];
  return {
    id: reference.messageId, applicationId: botId, guildId: reference.guildId, channelId: reference.channelId,
    user: { id: authorId, bot: false }, commandName: 'yuna', options: { data: [{ name: 'status', type: 1 }] },
    token: secret, deferred: false, replied: false, isChatInputCommand: () => true,
    acknowledgments, edits,
    /** Simulate acknowledging an interaction so its later private response can be tested. */
    async deferReply(options: unknown) { acknowledgments.push(options); this.deferred = true; },
    /** Capture the interaction response without sending anything to Discord. */
    async editReply(options: unknown) { edits.push(options); },
    ...overrides,
  };
}

/** Compose the test scenario with deterministic dependencies and observable checkpoints. */
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

/** Create a deterministic reply request for the transport under test. */
function reply(overrides: Partial<DiscordReplyRequest> = {}): DiscordReplyRequest {
  return { ...reference, content: 'hello @everyone <@100000000000000005>', nonce: reference.messageId,
    deadline: new Date(Date.now() + 60_000), ...overrides };
}

/** Mirror discord.js ordering: raw dispatch is exposed before the SDK MessageCreate event. */
function dispatchCreate(client: FakeClient, overrides: Record<string, unknown> = {}) {
  const payload = { ...apiMessage(), guild_id: reference.guildId, attachments: [], mentions: [{ id: botId }], ...overrides };
  client.emit(Events.Raw, { t: 'MESSAGE_CREATE', s: 10, d: payload }, 0);
  client.emit(Events.MessageCreate, message({ content: payload.content }));
  return payload;
}

test('original callback precedes conversation filtering and captures unmentioned creates with duplicate durable identities', async () => {
  const captured: { provenance: DiscordOriginalMessageProvenance; capture: DiscordOriginalMessageCapture }[] = [];
  const order: string[] = [];
  const { client, gateway } = await fixture({ /** Capture the original-dispatch callback independently of ordinary conversation handling. */ onOriginalMessage(provenance, capture) { order.push('original'); captured.push({ provenance, capture }); },
    /** Observe normalized conversation ingress or inject the test's owner-callback failure. */
    onMessage() { order.push('community'); } });
  try {
    dispatchCreate(client);
    assert.deepEqual(order, ['original', 'community']);
    const content = '  Unmentioned original <@100000000000000099>\n';
    for (let count = 0; count < 2; count += 1) {
      client.emit(Events.Raw, { t: 'MESSAGE_CREATE', s: 11 + count, d: { ...apiMessage(), guild_id: reference.guildId, content, attachments: [], mentions: [] } }, 0);
      client.emit(Events.MessageCreate, message({ content, mentions: { users: new Set(), parsedUsers: new Set() } }));
    }
    assert.deepEqual(order, ['original', 'community', 'original', 'original']);
    assert.equal(captured.length, 3);
    assert.equal(captured[1]?.capture.originalContent, content);
    assert.equal(captured[1]?.provenance.messageId, captured[2]?.provenance.messageId);
    assert.equal(captured[1]?.provenance.gatewaySequence, 11);
    assert.equal(captured[2]?.provenance.gatewaySequence, 12);
    assert.ok(!JSON.stringify(captured).includes(secret));
  } finally { await gateway.stop(); }
});

test('raw edits/deletes never replace an original and invalid or foreign creates do not cross ingress', async () => {
  const captures: DiscordOriginalMessageCapture[] = [];
  const { client, gateway } = await fixture({ /** Capture the original-dispatch callback independently of ordinary conversation handling. */ onOriginalMessage(_provenance, capture) { captures.push(capture); } });
  try {
    const payload = dispatchCreate(client);
    payload.content = 'changed SDK source';
    for (const t of ['MESSAGE_UPDATE', 'MESSAGE_DELETE']) client.emit(Events.Raw, { t, s: 11, d: payload }, 0);
    for (const override of [{ guild_id: foreignGuild }, { guild_id: undefined }, { id: 'invalid' }]) {
      client.emit(Events.Raw, { t: 'MESSAGE_CREATE', d: { ...payload, ...override } }, 0);
    }
    assert.equal(captures.length, 1);
    assert.equal(captures[0]?.originalContent, `<@${botId}> hello`);
  } finally { await gateway.stop(); }
});

test('original failures and slow capture never suppress Community or create a gateway outage', async () => {
  for (const mode of ['sync', 'async', 'pending'] as const) {
    const pending = deferred<void>();
    const { client, gateway, messages, unavailable } = await fixture({ /** Capture the original-dispatch callback independently of ordinary conversation handling. */ onOriginalMessage() {
      if (mode === 'sync') throw new Error(secret);
      return mode === 'async' ? Promise.reject(new Error(secret)) : pending.promise;
    } });
    try {
      dispatchCreate(client);
      assert.equal(messages.length, 1);
      await setImmediate();
      assert.equal(unavailable.length, 0);
      dispatchCreate(client);
      assert.equal(messages.length, 2);
    } finally { pending.resolve(); await gateway.stop(); }
  }
});

test('shutdown drains original callbacks and fences later creates while restricted content stays explicit', async () => {
  const pending = deferred<void>();
  const captured: DiscordOriginalMessageCapture[] = [];
  const { client, gateway } = await fixture({ /** Capture the original-dispatch callback independently of ordinary conversation handling. */ onOriginalMessage(_provenance, capture) { captured.push(capture); return pending.promise; } });
  try {
    client.contentIntent = false;
    dispatchCreate(client, { content: '', mentions: [] });
    assert.equal(captured[0]?.contentAccess, 'restricted');
    assert.equal(captured[0]?.originalContent, null);
    let stopped = false;
    const stopping = gateway.stop().then(() => { stopped = true; });
    dispatchCreate(client);
    await setImmediate();
    assert.equal(captured.length, 1);
    assert.equal(stopped, false);
    pending.resolve();
    await stopping;
    assert.equal(stopped, true);
  } finally { pending.resolve(); await gateway.stop(); }
});

test('command ingress acknowledges ephemerally before invoking plain-data owner code and suppresses pings', async () => {
  const received: NormalizedAdministrationCommand[] = [];
  const interaction = commandInteraction();
  const { client, gateway } = await fixture({ /** Capture the normalized command and simulate its owner response. */ onCommand(command) {
    assert.deepEqual(interaction.acknowledgments, [{ flags: MessageFlags.Ephemeral }]);
    received.push(command);
    return 'Ready @everyone';
  } });
  try {
    client.emit(Events.InteractionCreate, interaction);
    await setImmediate();
    assert.deepEqual(received, [{ actorId: authorId, guildId: reference.guildId, channelId: reference.channelId,
      sourceRequestId: reference.messageId, command: 'status', arguments: {} }]);
    assert.ok(Object.isFrozen(received[0]));
    assert.ok(!JSON.stringify(received).includes(secret));
    assert.deepEqual(interaction.edits, [{ content: 'Ready @everyone', allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } }]);
    client.emit(Events.InteractionCreate, interaction);
    await setImmediate();
    assert.equal(received.length, 1);
    assert.deepEqual(administrationCommandDefinition.options?.map(item => item.name), ['knowledge', 'memory', 'debate', 'usage', 'limit-clear', 'limit', 'action', 'ban', 'unban', 'kick', 'report', 'status', 'bootstrap', 'configure', 'remove', 'grant', 'revoke', 'pause', 'resume', 'channel-status', 'channel']);
  } finally { await gateway.stop(); }
});

test('full consent reviews remain private and attach complete bounded UTF-8 JSON without enabling mentions', async () => {
  const attachment = { filename: 'debate-scope.json', content: JSON.stringify({ rubric: 'Complete rubric '.repeat(400) }) };
  const { client, gateway } = await fixture({ /** Return a large complete review that cannot fit in the text response alone. */
    onCommand() { return { content: 'Review the complete scope @everyone', attachment }; } });
  try {
    const interaction = commandInteraction(); client.emit(Events.InteractionCreate, interaction); await setImmediate();
    assert.deepEqual(interaction.acknowledgments, [{ flags: MessageFlags.Ephemeral }]);
    const response = interaction.edits[0] as { files: { attachment: Buffer; name: string }[]; allowedMentions: unknown };
    assert.equal(response.files[0]!.name, attachment.filename); assert.equal(response.files[0]!.attachment.toString('utf8'), attachment.content);
    assert.deepEqual(response.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  } finally { await gateway.stop(); }
});

test('invalid or oversized review attachments never reach Discord', async () => {
  for (const attachment of [{ filename: '../secret.json', content: '{}' }, { filename: 'debate-scope.json', content: 'x'.repeat(65537) }]) {
    const { client, gateway } = await fixture({ /** Return a deliberately invalid attachment to exercise the transport bound. */
      onCommand() { return { content: 'Review', attachment }; } });
    try {
      const interaction = commandInteraction(); client.emit(Events.InteractionCreate, interaction); await setImmediate();
      assert.equal((interaction.edits[0] as { files?: unknown }).files, undefined);
      assert.match((interaction.edits[0] as { content: string }).content, /without a displayable response/);
    } finally { await gateway.stop(); }
  }
});

test('wrong-scope commands are ignored and malformed options receive only a private validation response', async () => {
  let calls = 0;
  const { client, gateway, messages } = await fixture({ /** Capture the normalized command and simulate its owner response. */ onCommand() { calls += 1; return 'unused'; } });
  try {
    for (const overrides of [{ guildId: null }, { guildId: foreignGuild }, { applicationId: foreignGuild },
      { user: { id: authorId, bot: true } }, { commandName: 'other' }, { isChatInputCommand: () => false }]) {
      const interaction = commandInteraction(overrides);
      client.emit(Events.InteractionCreate, interaction);
      await setImmediate();
      assert.deepEqual(interaction.acknowledgments, []);
    }
    const invalid = commandInteraction({ options: { data: [{ name: 'status', type: 1, options: [{ name: 'actorId', type: 3, value: botId }] }] } });
    client.emit(Events.InteractionCreate, invalid);
    await setImmediate();
    assert.equal(calls, 0);
    assert.equal(invalid.acknowledgments.length, 1);
    assert.match(JSON.stringify(invalid.edits), /Invalid Yuna command arguments/);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 1);
  } finally { await gateway.stop(); }
});

test('acknowledgement failure, callback failure and lost private responses never replay commands or leak errors', async () => {
  let calls = 0;
  const { client, gateway, messages } = await fixture({ /** Capture the normalized command and simulate its owner response. */ onCommand() { calls += 1; throw new Error(secret); } });
  try {
    const notAcknowledged = commandInteraction({ /** Simulate acknowledging an interaction so its later private response can be tested. */ async deferReply() { throw new Error(secret); } });
    client.emit(Events.InteractionCreate, notAcknowledged);
    await setImmediate();
    assert.equal(calls, 0);
    const failed = commandInteraction();
    client.emit(Events.InteractionCreate, failed);
    await setImmediate();
    assert.equal(calls, 1);
    assert.match(JSON.stringify(failed.edits), /outcome could not be confirmed/);
    assert.ok(!JSON.stringify(failed.edits).includes(secret));
    const lostResponse = commandInteraction({ /** Capture the interaction response without sending anything to Discord. */ async editReply() { throw new Error(secret); } });
    client.emit(Events.InteractionCreate, lostResponse);
    await setImmediate();
    assert.equal(calls, 2);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 1);
  } finally { await gateway.stop(); }
});

test('an outage or shutdown during acknowledgement prevents command execution', async () => {
  for (const shutdown of [false, true]) {
    const acknowledgment = deferred<void>();
    let calls = 0;
    const { client, gateway } = await fixture({ /** Capture the normalized command and simulate its owner response. */ onCommand() { calls += 1; return 'unused'; } });
    try {
      const interaction = commandInteraction({ deferReply: () => acknowledgment.promise });
      client.emit(Events.InteractionCreate, interaction);
      const stopping = shutdown ? gateway.stop() : undefined;
      if (!shutdown) client.emit(Events.ShardDisconnect);
      acknowledgment.resolve();
      await stopping;
      await setImmediate();
      assert.equal(calls, 0);
      assert.equal(interaction.edits.length, shutdown ? 0 : 1);
    } finally { acknowledgment.resolve(); await gateway.stop(); }
  }
});

const actorRole = '100000000000000010', botRole = '100000000000000011', targetRole = '100000000000000012';
const authorityCaller = { actorId: authorId, guildId: reference.guildId, sourceRequestId: reference.messageId };

/** Serve only explicit fresh REST routes; cached SDK role/member state is intentionally absent. */
function nativeRoutes(client: FakeClient) {
  const values = new Map<string, unknown>([
    [Routes.guild(reference.guildId), { id: reference.guildId, owner_id: foreignGuild }],
    [Routes.guildRoles(reference.guildId), [
      { id: reference.guildId, position: 0, permissions: '1024' },
      { id: actorRole, position: 5, permissions: '4' }, { id: botRole, position: 4, permissions: '4' },
      { id: targetRole, position: 3, permissions: '0' },
    ]],
    [Routes.guildMember(reference.guildId, authorId), { user: { id: authorId }, roles: [actorRole] }],
    [Routes.guildMember(reference.guildId, botId), { user: { id: botId }, roles: [botRole] }],
    [Routes.guildMember(reference.guildId, previousId), { user: { id: previousId }, roles: [targetRole] }],
    [Routes.channel(reference.channelId), { id: reference.channelId, guild_id: reference.guildId }],
  ]);
  client.getResult = async route => {
    if (!values.has(route)) throw new Error(secret);
    const value = values.get(route);
    if (value instanceof Error) throw value;
    return value;
  };
  return values;
}

test('native facts use fresh guild/member/role reads, exact operation bindings and current role hierarchy', async () => {
  const { client, gateway } = await fixture();
  const values = nativeRoutes(client);
  try {
    const operation = { capability: 'moderation.ban' as const, channelId: reference.channelId, targetUserId: previousId };
    const facts = await gateway.readFacts(authorityCaller, operation);
    assert.equal(facts.complete, true);
    assert.equal(facts.actorIsMember, true);
    assert.equal(facts.ownerId, foreignGuild);
    assert.equal(facts.actorPermissions, '1028');
    assert.equal(facts.botPermissions, '1028');
    assert.deepEqual(facts.operation, operation);
    assert.deepEqual(facts.target, { userId: previousId, isMember: true, isGuildOwner: false, isSelf: false, actorAboveTarget: true, botAboveTarget: true });
    assert.equal(client.gets.length, 6);
    values.set(Routes.guildMember(reference.guildId, authorId), { user: { id: authorId }, roles: [targetRole] });
    values.set(Routes.guildMember(reference.guildId, botId), { user: { id: botId }, roles: [targetRole] });
    const changed = await gateway.readFacts(authorityCaller, operation);
    assert.equal(changed.actorPermissions, '1024');
    assert.equal(changed.target?.actorAboveTarget, false);
    assert.equal(changed.target?.botAboveTarget, false);
    assert.equal(client.gets.length, 12);
  } finally { await gateway.stop(); }
});

test('native facts distinguish absent targets from unavailable authority and retain owner/bot protections', async () => {
  const { client, gateway } = await fixture();
  const values = nativeRoutes(client);
  const operation = { capability: 'moderation.ban', targetUserId: previousId };
  try {
    values.set(Routes.guildMember(reference.guildId, previousId), Object.assign(new Error(secret), { status: 404, code: 10007 }));
    const absent = await gateway.readFacts(authorityCaller, operation);
    assert.equal(absent.complete, true);
    assert.equal(absent.target?.isMember, false);
    for (const error of [Object.assign(new Error(secret), { status: 404, code: 10004 }), Object.assign(new Error(secret), { status: 403 }), new Error(secret)]) {
      values.set(Routes.guildMember(reference.guildId, previousId), error);
      const failed = await gateway.readFacts(authorityCaller, operation);
      assert.equal(failed.complete, false);
      assert.ok(!JSON.stringify(failed).includes(secret));
    }
    values.set(Routes.guildMember(reference.guildId, previousId), { user: { id: previousId }, roles: [targetRole] });
    values.set(Routes.guild(reference.guildId), { id: reference.guildId, owner_id: previousId });
    assert.equal((await gateway.readFacts(authorityCaller, operation)).target?.isGuildOwner, true);
    assert.equal((await gateway.readFacts(authorityCaller, { ...operation, targetUserId: botId })).target?.isSelf, true);
  } finally { await gateway.stop(); }
});

test('native facts reject malformed or mismatched responses and unknown authority routes without leaking errors', async () => {
  const { client, gateway } = await fixture();
  const operation = { capability: 'community.configure', channelId: reference.channelId };
  try {
    const corruptions: [string, unknown][] = [
      [Routes.guild(reference.guildId), { id: foreignGuild, owner_id: authorId }],
      [Routes.guildRoles(reference.guildId), [{ id: actorRole, position: 1, permissions: '8' }]],
      [Routes.guildRoles(reference.guildId), [{ id: reference.guildId, position: 0, permissions: 'bad' }]],
      [Routes.guildMember(reference.guildId, authorId), { user: { id: authorId }, roles: [foreignGuild] }],
      [Routes.guildMember(reference.guildId, botId), { user: { id: authorId }, roles: [botRole] }],
      [Routes.channel(reference.channelId), { id: reference.channelId, guild_id: foreignGuild }],
    ];
    for (const [route, value] of corruptions) {
      nativeRoutes(client).set(route, value);
      assert.equal((await gateway.readFacts(authorityCaller, operation)).complete, false);
    }
    const reads = client.gets.length;
    assert.equal((await gateway.readFacts({ ...authorityCaller, guildId: foreignGuild }, operation)).complete, false);
    assert.equal((await gateway.readFacts(authorityCaller, { capability: 'invented.permission' })).complete, false);
    assert.equal(client.gets.length, reads);
  } finally { await gateway.stop(); }
});

test('native hierarchy breaks equal-position ties by role snowflake and fences reads spanning an outage', async () => {
  const { client, gateway } = await fixture();
  const values = nativeRoutes(client);
  const operation = { capability: 'moderation.kick', targetUserId: previousId };
  try {
    values.set(Routes.guildRoles(reference.guildId), [
      { id: reference.guildId, position: 0, permissions: '0' },
      { id: actorRole, position: 2, permissions: '2' }, { id: botRole, position: 2, permissions: '2' },
      { id: targetRole, position: 2, permissions: '0' },
    ]);
    const tied = await gateway.readFacts(authorityCaller, operation);
    assert.equal(tied.target?.actorAboveTarget, true);
    assert.equal(tied.target?.botAboveTarget, true);
    const release = deferred<void>();
    const original = client.getResult;
    client.getResult = async (route, request) => { await release.promise; return original(route, request); };
    const pending = gateway.readFacts(authorityCaller, operation);
    operation.targetUserId = foreignGuild;
    client.emit(Events.ShardDisconnect);
    release.resolve();
    const crossed = await pending;
    assert.equal(crossed.complete, false);
    assert.equal(crossed.operation.targetUserId, previousId);
  } finally { await gateway.stop(); }
});

test('native facts fail closed for absent actors/bots and cancel unfinished REST reads at shutdown', async () => {
  const { client, gateway } = await fixture();
  try {
    nativeRoutes(client).set(Routes.guildMember(reference.guildId, authorId), Object.assign(new Error(secret), { status: 404, code: 10007 }));
    const missingActor = await gateway.readFacts(authorityCaller, { capability: 'guild.pause' });
    assert.equal(missingActor.complete, true);
    assert.equal(missingActor.actorIsMember, false);
    nativeRoutes(client).set(Routes.guildMember(reference.guildId, botId), Object.assign(new Error(secret), { status: 404, code: 10007 }));
    assert.equal((await gateway.readFacts(authorityCaller, { capability: 'guild.pause' })).complete, false);
    const entered = deferred<void>();
    client.getResult = async (_route, request) => {
      entered.resolve();
      return new Promise((_resolve, reject) => {
        if (request.signal?.aborted) reject(new Error(secret));
        else request.signal?.addEventListener('abort', () => reject(new Error(secret)), { once: true });
      });
    };
    const pending = gateway.readFacts(authorityCaller, { capability: 'guild.pause' });
    await entered.promise;
    await gateway.stop();
    assert.equal((await pending).complete, false);
  } finally { await gateway.stop(); }
});

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
    /** Observe recovery of the durable availability fence or inject the test's recovery failure. */
    async onAvailable() {
      availableCalls += 1;
      if (availableCalls === 2) { resumeEntered.resolve(); await finishResume.promise; }
      transitions.push('available');
    },
    /** Observe the durable outage fence or inject its storage failure. */
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

test.each(['message', 'invalidation'] as const)('a rejected %s callback recovers a healthy socket after fencing missed work', async kind => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const transitions: string[] = [];
  let calls = 0;
  /** Invoke the chosen owner callback to reproduce its storage-failure path. */
  const callback = async () => { if (++calls === 1) throw new Error(secret); };
  const { client, gateway, messages } = await fixture({
    ...(kind === 'message' ? { onMessage: callback } : { onInvalidation: callback }),
    /** Observe recovery of the durable availability fence or inject the test's recovery failure. */
    onAvailable() { transitions.push('available'); },
    /** Observe the durable outage fence or inject its storage failure. */
    onUnavailable() { transitions.push('unavailable'); },
  });
  try {
    client.emit(kind === 'message' ? Events.MessageCreate : Events.MessageDelete, message());
    await setImmediate();
    assert.deepEqual(transitions, ['available', 'unavailable']);
    assert.equal((await gateway.sendReply(reply(), signal())).classification, 'definitive_failure');
    client.emit(Events.MessageCreate, message());
    assert.equal(calls, 1);
    await jest.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(transitions, ['available', 'unavailable', 'available']);
    client.emit(Events.MessageCreate, message());
    await setImmediate();
    assert.equal(kind === 'message' ? calls : messages.length, kind === 'message' ? 2 : 1);
  } finally { await gateway.stop(); jest.useRealTimers(); }
});

test('failed unavailable writes are retried serially and must succeed before healthy-socket recovery', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const fence = deferred<void>();
  const transitions: string[] = [];
  let attempts = 0;
  const { client, gateway, messages } = await fixture({
    /** Observe source invalidation or inject the test's owner failure. */
    onInvalidation() { throw new Error(secret); },
    /** Observe recovery of the durable availability fence or inject the test's recovery failure. */
    onAvailable() { transitions.push('available'); },
    /** Observe the durable outage fence or inject its storage failure. */
    async onUnavailable() {
      attempts += 1;
      if (attempts === 1) throw new Error(secret);
      if (attempts === 2) await fence.promise;
      transitions.push('unavailable');
    },
  });
  try {
    client.emit(Events.MessageDelete, message());
    await setImmediate();
    assert.equal(attempts, 1);
    await jest.advanceTimersByTimeAsync(1_000);
    assert.equal(attempts, 2);
    await jest.advanceTimersByTimeAsync(10_000);
    assert.equal(attempts, 2);
    assert.deepEqual(transitions, ['available']);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 0);
    fence.resolve();
    await setImmediate();
    assert.deepEqual(transitions, ['available', 'unavailable', 'available']);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 1);
  } finally { fence.resolve(); await gateway.stop(); jest.useRealTimers(); }
});

test('an actual outage retries a failed fence but cannot reopen intake until Discord resumes', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  let attempts = 0;
  const transitions: string[] = [];
  const { client, gateway, messages } = await fixture({
    /** Observe recovery of the durable availability fence or inject the test's recovery failure. */
    onAvailable() { transitions.push('available'); },
    /** Observe the durable outage fence or inject its storage failure. */
    onUnavailable() {
      if (++attempts === 1) throw new Error(secret);
      transitions.push('unavailable');
    },
  });
  try {
    // Cached SDK readiness can briefly lag the disconnect event; it cannot reopen the gate.
    client.emit(Events.ShardDisconnect);
    await setImmediate();
    await jest.advanceTimersByTimeAsync(5_000);
    assert.equal(attempts, 2);
    assert.deepEqual(transitions, ['available', 'unavailable']);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 0);
    client.emit(Events.ShardResume);
    await setImmediate();
    assert.deepEqual(transitions, ['available', 'unavailable', 'available']);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 1);
  } finally { await gateway.stop(); jest.useRealTimers(); }
});

test('a resume event recovers a rejected availability chain and a failed resume is fenced before retry', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  let unavailableCalls = 0;
  let availableCalls = 0;
  const transitions: string[] = [];
  const { client, gateway, messages } = await fixture({
    /** Observe recovery of the durable availability fence or inject the test's recovery failure. */
    onAvailable() {
      if (++availableCalls === 2) throw new Error(secret);
      transitions.push('available');
    },
    /** Observe the durable outage fence or inject its storage failure. */
    onUnavailable() {
      if (++unavailableCalls === 1) throw new Error(secret);
      transitions.push('unavailable');
    },
  });
  try {
    client.emit(Events.ShardDisconnect);
    await setImmediate();
    // Resume before the timer fires: the rejected fence must not poison the promise chain.
    client.emit(Events.ShardResume);
    await setImmediate();
    assert.equal(availableCalls, 2);
    assert.deepEqual(transitions, ['available', 'unavailable', 'unavailable']);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 0);
    await jest.advanceTimersByTimeAsync(1_000);
    assert.equal(availableCalls, 3);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 1);
  } finally { await gateway.stop(); jest.useRealTimers(); }
});

test('a new outage wins over an in-flight timer recovery and leaves a final durable fence', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const recovery = deferred<void>();
  let availableCalls = 0;
  const transitions: string[] = [];
  const { client, gateway, messages } = await fixture({
    /** Observe source invalidation or inject the test's owner failure. */
    onInvalidation() { throw new Error(secret); },
    /** Observe recovery of the durable availability fence or inject the test's recovery failure. */
    async onAvailable() {
      if (++availableCalls === 2) await recovery.promise;
      transitions.push('available');
    },
    /** Observe the durable outage fence or inject its storage failure. */
    onUnavailable() { transitions.push('unavailable'); },
  });
  try {
    client.emit(Events.MessageDelete, message());
    await setImmediate();
    await jest.advanceTimersByTimeAsync(1_000);
    assert.equal(availableCalls, 2);
    client.emit(Events.ShardDisconnect);
    recovery.resolve();
    await setImmediate();
    await jest.advanceTimersByTimeAsync(5_000);
    assert.deepEqual(transitions, ['available', 'unavailable', 'available', 'unavailable']);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 0);
    assert.equal((await gateway.sendReply(reply(), signal())).classification, 'definitive_failure');
  } finally { recovery.resolve(); await gateway.stop(); jest.useRealTimers(); }
});

test('persistent fence failures retry at a bounded rate and stop cancels future attempts', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  let attempts = 0;
  const { client, gateway, messages } = await fixture({
    /** Observe source invalidation or inject the test's owner failure. */
    onInvalidation() { throw new Error(secret); },
    /** Observe the durable outage fence or inject its storage failure. */
    onUnavailable() { attempts += 1; throw new Error(secret); },
  });
  try {
    client.emit(Events.MessageDelete, message());
    await setImmediate();
    assert.equal(attempts, 1);
    await jest.advanceTimersByTimeAsync(3_000);
    assert.equal(attempts, 4);
    client.emit(Events.MessageCreate, message());
    assert.equal(messages.length, 0);
    await gateway.stop();
    const stoppedAttempts = attempts;
    await jest.advanceTimersByTimeAsync(10_000);
    assert.equal(attempts, stoppedAttempts);
    assert.equal(jest.getTimerCount(), 0);
  } finally { await gateway.stop(); jest.useRealTimers(); }
});

test('stop cancels a pending recovery timer and drains an already running recovery before its final fence', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  try {
    for (const inFlight of [false, true]) {
      const recovery = deferred<void>();
      const transitions: string[] = [];
      let availableCalls = 0;
      const { client, gateway } = await fixture({
        /** Observe source invalidation or inject the test's owner failure. */
        onInvalidation() { throw new Error(secret); },
        /** Observe recovery of the durable availability fence or inject the test's recovery failure. */
        async onAvailable() {
          if (++availableCalls === 2) await recovery.promise;
          transitions.push('available');
        },
        /** Observe the durable outage fence or inject its storage failure. */
        onUnavailable() { transitions.push('unavailable'); },
      });
      try {
        client.emit(Events.MessageDelete, message());
        await setImmediate();
        if (inFlight) {
          await jest.advanceTimersByTimeAsync(1_000);
          assert.equal(availableCalls, 2);
        }
        const stopping = gateway.stop();
        recovery.resolve();
        await stopping;
        await jest.advanceTimersByTimeAsync(10_000);
        assert.equal(availableCalls, inFlight ? 2 : 1);
        assert.equal(transitions.at(-1), 'unavailable');
        assert.equal(client.destroyed, 1);
        assert.equal((await gateway.sendReply(reply(), signal())).classification, 'definitive_failure');
      } finally { recovery.resolve(); await gateway.stop(); }
    }
  } finally { jest.useRealTimers(); }
});

test('startup cancellation/failure never retain token-bearing SDK errors', async () => {
  const client = new FakeClient();
  client.login = async () => { throw new Error(secret, { cause: new Error(secret) }); };
  const gateway = new DiscordGateway({ token: secret, guildId: reference.guildId, /** Observe normalized conversation ingress or inject the test's owner-callback failure. */ onMessage() {}, /** Observe source invalidation or inject the test's owner failure. */ onInvalidation() {} }, {
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
  const interrupted = new DiscordGateway({ token: secret, guildId: reference.guildId, /** Observe normalized conversation ingress or inject the test's owner-callback failure. */ onMessage() {}, /** Observe source invalidation or inject the test's owner failure. */ onInvalidation() {} }, {
    createClient: () => blocked as unknown as Client,
  });
  const abort = new AbortController();
  const starting = interrupted.start(abort.signal);
  abort.abort();
  await assert.rejects(starting, /Discord startup/);
  await interrupted.stop();
  assert.equal(blocked.destroyed, 1);
});

test('native reads accept bounded internal correlation IDs while command ingress remains snowflake-only', async () => {
  const { client, gateway } = await fixture(); nativeRoutes(client);
  try {
    const caller = { ...authorityCaller, sourceRequestId: 'candidate-current:stored-plan-id' };
    const facts = await gateway.readFacts(caller, { capability: 'administration.manage' });
    assert.equal(facts.complete, true); assert.equal(facts.sourceRequestId, caller.sourceRequestId);
    for (const sourceRequestId of ['', 'x'.repeat(201)]) {
      assert.equal((await gateway.readFacts({ ...caller, sourceRequestId }, { capability: 'administration.manage' })).complete, false);
    }
  } finally { await gateway.stop(); }
});
