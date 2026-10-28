/** Exercise native moderation checks and effect attribution without any Discord connection. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from '@jest/globals';
import { PermissionFlagsBits, Routes, type Client } from 'discord.js';
import { DiscordModerationTransport, hashDiscordModerationRequest, type DiscordModerationOperation,
  type DiscordModerationPreparationRequest, type DiscordModerationRequest } from '../../src/discord/moderation-transport.js';

const guildId = '100000000000000001', botId = '100000000000000002', targetUserId = '100000000000000003';
const botRole = '100000000000000004', targetRole = '100000000000000005', ownerId = '100000000000000006';
const channelId = '100000000000000007', dmId = '100000000000000008';
/** Create a fresh uncanceled signal so one test cannot abort another. */
const signal = () => new AbortController().signal;
type Options = { body?: Record<string, unknown>; reason?: string; signal?: AbortSignal; query?: URLSearchParams };
type Call = { method: string; route: string; options: Options };

/** A REST-shaped fake retains exact calls and permits deterministic failures. */
class FakeClient {
  readonly calls: Call[] = [];
  owner = ownerId;
  botPermissions = PermissionFlagsBits.BanMembers | PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
  targetPosition = 1;
  botPosition = 2;
  memberError: unknown = null;
  overwrite: unknown[] = [];
  channelType = 0;
  timedOut: string | null = null;
  effectError: unknown = null;
  getOverride: ((route: string) => unknown) | null = null;
  postOverride: ((route: string, options: Options) => unknown) | null = null;
  request: DiscordModerationRequest | null = null;
  readonly rest = {
    get: async (route: string, options: Options) => {
      this.calls.push({ method: 'GET', route, options });
      if (this.getOverride) return this.getOverride(route);
      if (route === Routes.guild(guildId)) return { id: guildId, owner_id: this.owner };
      if (route === Routes.guildRoles(guildId)) return [
        { id: guildId, position: 0, permissions: '0' },
        { id: botRole, position: this.botPosition, permissions: this.botPermissions.toString() },
        { id: targetRole, position: this.targetPosition, permissions: '0' },
      ];
      if (route === Routes.guildMember(guildId, botId)) return { user: { id: botId }, roles: [botRole], communication_disabled_until: this.timedOut };
      if (route === Routes.guildMember(guildId, targetUserId)) {
        if (this.memberError) throw this.memberError;
        return { user: { id: targetUserId }, roles: [targetRole] };
      }
      if (route === Routes.channel(channelId)) return { id: channelId, guild_id: guildId, type: this.channelType, permission_overwrites: this.overwrite };
      throw new Error(`Unexpected route ${route}`);
    },
    post: async (route: string, options: Options) => {
      this.calls.push({ method: 'POST', route, options });
      if (this.postOverride) return this.postOverride(route, options);
      if (route === Routes.userChannels()) return { id: dmId, type: 1, recipients: [{ id: targetUserId }] };
      if (this.effectError) throw this.effectError;
      return message(this.request!);
    },
    put: async (route: string, options: Options) => { this.calls.push({ method: 'PUT', route, options }); if (this.effectError) throw this.effectError; },
    delete: async (route: string, options: Options) => { this.calls.push({ method: 'DELETE', route, options }); if (this.effectError) throw this.effectError; },
  };
}

/** Default ban payload has no message deletion. */
function preparation(operation: DiscordModerationOperation = { schemaVersion: 1, kind: 'ban', reason: 'reviewed violation', deleteMessageSeconds: 0 }): DiscordModerationPreparationRequest {
  return { actionId: randomUUID(), guildId, targetUserId, operation };
}
/** A concrete claimed attempt has exactly one immutable endpoint fingerprint. */
function request(operation?: DiscordModerationOperation): DiscordModerationRequest {
  const input = preparation(operation), warning = input.operation.kind === 'warning';
  const partial = { ...input, attemptId: randomUUID(), channelId: warning ? input.operation.kind === 'warning' && input.operation.destination.kind === 'channel'
    ? input.operation.destination.channelId : dmId : null, nonce: warning ? 'attempt_123' : null, claimedAt: new Date() };
  return { ...partial, requestFingerprint: hashDiscordModerationRequest(partial) };
}
/** Gateway availability can be toggled independently from fake REST results. */
function harness() {
  const client = new FakeClient(), shutdown = new AbortController(); let available = true;
  return { client, shutdown, unavailable: () => { available = false; }, transport: new DiscordModerationTransport(
    () => client as unknown as Client, () => botId, () => available, shutdown.signal) };
}
/** Warnings carry only their approved text and explicit mention allowlist. */
function warning(destination: 'dm' | 'channel' = 'dm'): DiscordModerationOperation {
  return { schemaVersion: 1, kind: 'warning', text: 'Please review the community rules.',
    destination: destination === 'dm' ? { kind: 'direct_message' } : { kind: 'channel', channelId },
    allowedMentions: { users: [], roles: [], everyone: false } };
}
/** Construct a returned own-message with the attempt timestamp and nonce. */
function message(input: DiscordModerationRequest, changes: Record<string, unknown> = {}) {
  return { id: snowflake(input.claimedAt.getTime()), channel_id: input.channelId, author: { id: botId }, nonce: input.nonce,
    content: input.operation.kind === 'warning' ? input.operation.text : '', timestamp: input.claimedAt.toISOString(), ...changes };
}
/** Build Discord IDs that carry a deterministic creation timestamp. */
function snowflake(time: number): string { return ((BigInt(time) - 1_420_070_400_000n) << 22n).toString(); }

test('ban preparation uses fresh REST facts and forbids hierarchy, owner and self targets', async () => {
  const { client, transport } = harness(), input = preparation();
  assert.equal((await transport.prepare(input, signal())).permitted, true);
  assert.equal(client.calls.length, 4);
  assert(client.calls.every(call => call.method === 'GET'));
  client.targetPosition = 3;
  assert.equal((await transport.prepare(input, signal())).permitted, false);
  client.botPermissions = PermissionFlagsBits.Administrator;
  assert.equal((await transport.prepare(input, signal())).permitted, false, 'Administrator does not bypass hierarchy');
  client.targetPosition = 1; client.owner = targetUserId;
  assert.equal((await transport.prepare(input, signal())).permitted, false);
  client.owner = ownerId;
  assert.equal((await transport.prepare({ ...input, targetUserId: botId }, signal())).permitted, false);
});

test('equal-position hierarchy uses the lower snowflake and shared highest role cannot outrank itself', async () => {
  const { client, transport } = harness(); client.targetPosition = client.botPosition;
  assert.equal((await transport.prepare(preparation(), signal())).permitted, true);
  client.botPosition = 0; client.targetPosition = 0;
  assert.equal((await transport.prepare(preparation(), signal())).permitted, false);
});

test('only exact Unknown Member proves absent target and native permission is still required', async () => {
  const { client, transport } = harness(); client.memberError = { status: 404, code: 10007 };
  assert.equal((await transport.prepare(preparation(), signal())).permitted, true);
  client.botPermissions = 0n;
  const denied = await transport.prepare(preparation(), signal());
  assert.equal(denied.complete, true); assert.equal(denied.permitted, false);
  client.memberError = { status: 404, code: 10004 };
  assert.equal((await transport.prepare(preparation(), signal())).complete, false);
  client.memberError = { status: 403, code: 50013 };
  assert.equal((await transport.prepare(preparation(), signal())).complete, false);
});

test('unban reads bot BAN_MEMBERS without requiring a target membership', async () => {
  const { client, transport } = harness(); client.memberError = new Error('Target membership should not be queried');
  assert.equal((await transport.prepare(preparation({ schemaVersion: 1, kind: 'unban', reason: 'approved appeal' }), signal())).permitted, true);
  assert(!client.calls.some(call => call.route === Routes.guildMember(guildId, targetUserId)));
});

test('kick preparation requires KICK_MEMBERS, present target and current hierarchy without a ban fallback', async () => {
  const { client, transport } = harness(), input = preparation({ schemaVersion: 1, kind: 'kick', reason: 'Explicit kick' });
  assert.equal((await transport.prepare(input, signal())).permitted, false, 'BAN_MEMBERS alone cannot kick');
  client.botPermissions = PermissionFlagsBits.KickMembers;
  assert.equal((await transport.prepare(input, signal())).permitted, true);
  client.memberError = { status: 404, code: 10007 };
  const absent = await transport.prepare(input, signal());
  assert.equal(absent.complete, true); assert.equal(absent.permitted, false, 'A kick requires current membership');
  client.memberError = { status: 404, code: 10004 };
  assert.equal((await transport.prepare(input, signal())).complete, false);
  client.memberError = null; client.targetPosition = 3; client.botPermissions = PermissionFlagsBits.Administrator;
  assert.equal((await transport.prepare(input, signal())).permitted, false, 'Administrator cannot bypass hierarchy');
  client.targetPosition = 1; client.owner = targetUserId;
  assert.equal((await transport.prepare(input, signal())).permitted, false);
  client.owner = ownerId;
  assert.equal((await transport.prepare({ ...input, targetUserId: botId }, signal())).permitted, false);
  assert(client.calls.every(call => call.method === 'GET'));
});

test('DM preparation resolves the exact recipient and never sends text or falls back', async () => {
  const { client, transport } = harness(), input = preparation(warning());
  assert.deepEqual(await transport.prepare(input, signal()).then(({ observedAt: _time, ...value }) => value), {
    actionId: input.actionId, guildId, targetUserId, kind: 'warning', complete: true, permitted: true, channelId: dmId,
  });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0]!.options.body, { recipient_id: targetUserId });
  client.postOverride = () => ({ id: channelId, type: 1, recipients: [{ id: ownerId }] });
  assert.equal((await transport.prepare(input, signal())).complete, false);
  client.postOverride = () => { throw { status: 403, code: 50007 }; };
  assert.equal((await transport.prepare(input, signal())).permitted, false);
  assert(client.calls.every(call => call.route === Routes.userChannels()));
});

test('channel warnings apply fresh overwrites, timeouts and supported destination types', async () => {
  const { client, transport } = harness(), input = preparation(warning('channel'));
  assert.equal((await transport.prepare(input, signal())).permitted, true);
  client.overwrite = [{ id: guildId, type: 0, deny: PermissionFlagsBits.SendMessages.toString(), allow: '0' }];
  assert.equal((await transport.prepare(input, signal())).permitted, false);
  client.overwrite.push({ id: botRole, type: 0, deny: '0', allow: PermissionFlagsBits.SendMessages.toString() });
  assert.equal((await transport.prepare(input, signal())).permitted, true);
  client.overwrite.push({ id: botId, type: 1, deny: PermissionFlagsBits.ViewChannel.toString(), allow: '0' });
  assert.equal((await transport.prepare(input, signal())).permitted, false);
  client.botPermissions = PermissionFlagsBits.Administrator;
  assert.equal((await transport.prepare(input, signal())).permitted, true);
  client.timedOut = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await transport.prepare(input, signal())).permitted, false);
  client.timedOut = null; client.channelType = 11;
  assert.equal((await transport.prepare(input, signal())).permitted, false);
});

test('preparation fails closed when unavailable, cancelled or given malformed permission facts', async () => {
  const { client, transport, unavailable } = harness();
  client.getOverride = () => ({ id: guildId });
  assert.equal((await transport.prepare(preparation(), signal())).complete, false);
  const controller = new AbortController(); controller.abort(); client.calls.length = 0;
  assert.equal((await transport.prepare(preparation(), controller.signal)).complete, false); assert.equal(client.calls.length, 0);
  unavailable(); assert.equal((await transport.prepare(preparation(), signal())).complete, false); assert.equal(client.calls.length, 0);
});

test('ban and unban dispatch one endpoint call with exact content-free audit correlation', async () => {
  const { client, transport } = harness(), ban = request();
  assert.deepEqual(await transport.execute(ban, signal()), { classification: 'confirmed', code: 'ban_applied', httpStatus: 204 });
  assert.equal(client.calls.length, 1); assert.equal(client.calls[0]!.method, 'PUT');
  assert.equal(client.calls[0]!.route, Routes.guildBan(guildId, targetUserId));
  assert.deepEqual(client.calls[0]!.options.body, { delete_message_seconds: 0 });
  assert.equal(client.calls[0]!.options.reason, `yuna:${ban.actionId}:${ban.attemptId}`);
  const unban = request({ schemaVersion: 1, kind: 'unban', reason: 'private appeal text' });
  assert.equal((await transport.execute(unban, signal())).classification, 'confirmed');
  assert.equal(client.calls[1]!.method, 'DELETE'); assert(!JSON.stringify(client.calls).includes('private appeal text'));
});

test('kick dispatch calls remove member once, binds the kick fingerprint and confirms 204 without an action ID', async () => {
  const { client, transport } = harness(), input = request({ schemaVersion: 1, kind: 'kick', reason: 'private kick reason' });
  assert.deepEqual(await transport.execute(input, signal()), { classification: 'confirmed', code: 'member_kicked', httpStatus: 204 });
  assert.equal(client.calls.length, 1); assert.equal(client.calls[0]!.method, 'DELETE');
  assert.equal(client.calls[0]!.route, Routes.guildMember(guildId, targetUserId));
  assert.equal(client.calls[0]!.options.body, undefined);
  assert.equal(client.calls[0]!.options.reason, `yuna:${input.actionId}:${input.attemptId}`);
  assert(!JSON.stringify(client.calls).includes('private kick reason'));
  assert.notEqual(input.requestFingerprint, hashDiscordModerationRequest({ ...input,
    operation: { schemaVersion: 1, kind: 'unban', reason: 'private kick reason' } }));
  client.calls.length = 0;
  assert.equal((await transport.execute({ ...input, targetUserId: ownerId }, signal())).code, 'invalid_moderation_request');
  assert.equal(client.calls.length, 0);
});

test('kick timeouts and server failures stay unknown with one request; an absent-member rejection is never success', async () => {
  const { client, transport } = harness();
  for (const [error, classification] of [[{ status: 404, code: 10007 }, 'definitive_failure'], [{ status: 403 }, 'definitive_failure'],
    [{ status: 408 }, 'unknown'], [{ status: 502 }, 'unknown'], [new Error('connection reset'), 'unknown']] as const) {
    client.effectError = error; client.calls.length = 0;
    assert.equal((await transport.execute(request({ schemaVersion: 1, kind: 'kick', reason: 'Explicit kick' }), signal())).classification, classification);
    assert.equal(client.calls.length, 1); assert.equal(client.calls[0]!.route, Routes.guildMember(guildId, targetUserId));
  }
});

test('warning dispatch preserves exact text, mention allowlist, destination and bounded nonce', async () => {
  const { client, transport } = harness(), input = request(warning()); client.request = input;
  const result = await transport.execute(input, signal());
  assert.equal(result.classification, 'confirmed'); assert.equal(result.discordMessageId, snowflake(input.claimedAt.getTime()));
  assert.equal(client.calls.length, 1); assert.equal(client.calls[0]!.route, Routes.channelMessages(dmId));
  assert.deepEqual(client.calls[0]!.options.body?.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
  assert.equal(client.calls[0]!.options.body?.enforce_nonce, true);
  client.postOverride = () => message(input, { author: { id: ownerId } });
  assert.equal((await transport.execute(input, signal())).classification, 'unknown');
});

test('invalid payload, destination, nonce and fingerprint cause no dispatch', async () => {
  const { client, transport } = harness(), input = request(warning('channel'));
  assert.equal((await transport.execute({ ...input, requestFingerprint: 'a'.repeat(64) }, signal())).classification, 'definitive_failure');
  assert.equal((await transport.execute({ ...input, channelId: dmId }, signal())).classification, 'definitive_failure');
  assert.equal((await transport.execute({ ...input, nonce: 'x'.repeat(26) }, signal())).classification, 'definitive_failure');
  const excessive = request({ schemaVersion: 1, kind: 'ban', reason: 'x', deleteMessageSeconds: 604_801 });
  assert.equal((await transport.execute(excessive, signal())).classification, 'definitive_failure');
  assert.equal(client.calls.length, 0);
});

test('external rejection is definitive while timeouts, network failures and server failures stay unknown without retry', async () => {
  const { client, transport } = harness();
  for (const [error, classification] of [[{ status: 403 }, 'definitive_failure'], [{ status: 429 }, 'definitive_failure'],
    [{ status: 408 }, 'unknown'], [{ status: 502 }, 'unknown'], [new Error('connection reset'), 'unknown']] as const) {
    client.effectError = error; client.calls.length = 0;
    assert.equal((await transport.execute(request(), signal())).classification, classification); assert.equal(client.calls.length, 1);
  }
  const controller = new AbortController(); controller.abort(); client.calls.length = 0;
  assert.equal((await transport.execute(request(), controller.signal)).classification, 'definitive_failure'); assert.equal(client.calls.length, 0);
});

test('audit reconciliation requires exact executor, target, kind, attempt reason and timestamp', async () => {
  const { client, transport } = harness(), input = request();
  const entry = { id: snowflake(input.claimedAt.getTime()), user_id: botId, target_id: targetUserId, action_type: 22,
    reason: `yuna:${input.actionId}:${input.attemptId}` };
  client.getOverride = () => ({ audit_log_entries: [entry] });
  const result = await transport.reconcile(input, signal());
  assert.equal(result?.source, 'discord_audit_log'); assert.equal(result?.reference, entry.id);
  assert.equal(client.calls[0]!.options.query?.get('user_id'), botId);
  for (const change of [{ user_id: ownerId }, { target_id: ownerId }, { action_type: 23 }, { reason: `yuna:${input.actionId}:other` },
    { id: snowflake(input.claimedAt.getTime() - 30_000) }]) {
    client.getOverride = () => ({ audit_log_entries: [{ ...entry, ...change }] });
    assert.equal(await transport.reconcile(input, signal()), null);
  }
  client.getOverride = () => ({ audit_log_entries: [entry, entry] });
  assert.equal(await transport.reconcile(input, signal()), null);
  assert(client.calls.every(call => call.method === 'GET'));
});

test('kick reconciliation only accepts the exact MEMBER_KICK audit entry and never infers success from absence', async () => {
  const { client, transport } = harness(), input = request({ schemaVersion: 1, kind: 'kick', reason: 'Explicit kick' });
  const entry = { id: snowflake(input.claimedAt.getTime()), user_id: botId, target_id: targetUserId, action_type: 20,
    reason: `yuna:${input.actionId}:${input.attemptId}` };
  client.getOverride = () => ({ audit_log_entries: [] }); client.memberError = { status: 404, code: 10007 };
  assert.equal(await transport.reconcile(input, signal()), null);
  for (const change of [{ user_id: ownerId }, { target_id: ownerId }, { action_type: 22 }, { reason: `yuna:${input.actionId}:other` },
    { id: snowflake(input.claimedAt.getTime() - 30_000) }]) {
    client.getOverride = () => ({ audit_log_entries: [{ ...entry, ...change }] });
    assert.equal(await transport.reconcile(input, signal()), null);
  }
  client.getOverride = () => ({ audit_log_entries: [entry] });
  assert.equal((await transport.reconcile(input, signal()))?.outcome.discordAuditEntryId, entry.id);
  assert(client.calls.every(call => call.method === 'GET' && call.route === Routes.guildAuditLog(guildId)
    && call.options.query?.get('action_type') === '20'));
});

test('warning reconciliation requires exact author, channel, nonce, text and timestamp; missing history remains unknown', async () => {
  const { client, transport } = harness(), input = request(warning());
  client.getOverride = () => [message(input)];
  assert.equal((await transport.reconcile(input, signal()))?.source, 'message_lookup');
  for (const change of [{ author: { id: ownerId } }, { channel_id: channelId }, { nonce: null }, { content: 'similar text' },
    { timestamp: new Date(input.claimedAt.getTime() - 30_000).toISOString() }, { webhook_id: ownerId }]) {
    client.getOverride = () => [message(input, change)]; assert.equal(await transport.reconcile(input, signal()), null);
  }
  client.getOverride = () => []; assert.equal(await transport.reconcile(input, signal()), null);
  client.getOverride = () => { throw { status: 403 }; }; assert.equal(await transport.reconcile(input, signal()), null);
  assert(client.calls.every(call => call.method === 'GET'));
});

test('caller edits during SDK work cannot change the approved payload or its reconciliation binding', async () => {
  const { client, transport } = harness(), input = request(warning());
  const original = input.operation.kind === 'warning' ? input.operation.text : '';
  client.postOverride = (_route, options) => {
    if (input.operation.kind === 'warning') { input.operation.text = 'changed after admission'; input.operation.allowedMentions.users.push(ownerId); }
    assert.deepEqual(options.body?.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
    return message(input, { content: original });
  };
  assert.equal((await transport.execute(input, signal())).classification, 'confirmed');
});

test('old or future attempt timestamps cannot cause a new external dispatch', async () => {
  const { client, transport } = harness(), input = request();
  assert.equal((await transport.execute({ ...input, claimedAt: new Date(Date.now() - 180_000) }, signal())).code, 'moderation_attempt_expired');
  assert.equal((await transport.execute({ ...input, claimedAt: new Date(Date.now() + 30_000) }, signal())).code, 'moderation_attempt_expired');
  assert.equal(client.calls.length, 0);
});
