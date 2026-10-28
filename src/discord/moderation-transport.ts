/** Discord-only moderation transport: fresh native facts, single dispatch, and exact attributable reconciliation. */
import { createHash } from 'node:crypto';
import { MessageFlags, PermissionFlagsBits, Routes, type Client } from 'discord.js';
import type { DiscordStateReader } from './state-reader.js';
import { assertDiscordId, assertUuid, invariant } from '../platform/db/entity-values.js';

export type DiscordModerationOperation =
  | { schemaVersion: 1; kind: 'ban'; reason: string; deleteMessageSeconds: number }
  | { schemaVersion: 1; kind: 'unban'; reason: string }
  | { schemaVersion: 1; kind: 'kick'; reason: string }
  | { schemaVersion: 1; kind: 'warning'; text: string; destination: { kind: 'channel'; channelId: string } | { kind: 'direct_message' };
      allowedMentions: { users: string[]; roles: string[]; everyone: false } };
export interface DiscordModerationPreparationRequest { actionId: string; guildId: string; targetUserId: string; operation: DiscordModerationOperation }
export interface DiscordModerationPreparation {
  actionId: string; guildId: string; targetUserId: string; kind: DiscordModerationOperation['kind'];
  observedAt: Date; complete: boolean; permitted: boolean; channelId: string | null;
}
export interface DiscordModerationRequest extends DiscordModerationPreparationRequest {
  attemptId: string; channelId: string | null; nonce: string | null; requestFingerprint: string; claimedAt: Date;
}
export interface DiscordModerationOutcome {
  classification: 'confirmed' | 'definitive_failure' | 'unknown'; code: string;
  httpStatus?: number; discordMessageId?: string; discordAuditEntryId?: string;
}
export interface DiscordModerationReconciliation {
  outcome: DiscordModerationOutcome; source: 'discord_audit_log' | 'message_lookup'; reference: string;
}
interface NativeRole { id: string; position: number; permissions: bigint }
interface NativeMember { roles: string[]; permissions: bigint; highest: NativeRole; timedOut: boolean }
const readTimeoutMs = 5_000;
const dispatchTimeoutMs = 10_000;
const auditTypes = { ban: 22, unban: 23, kick: 20 } as const;

/** Canonical endpoint fingerprint binds the accepted payload and concrete destination to this single attempt. */
export function hashDiscordModerationRequest(request: Omit<DiscordModerationRequest, 'requestFingerprint' | 'claimedAt'>): string {
  const operation = request.operation.kind === 'warning'
    ? { schemaVersion: 1, kind: 'warning', text: request.operation.text, destination: request.operation.destination.kind === 'channel'
        ? { kind: 'channel', channelId: request.operation.destination.channelId } : { kind: 'direct_message' },
      allowedMentions: { users: [...request.operation.allowedMentions.users], roles: [...request.operation.allowedMentions.roles], everyone: false } }
    : request.operation.kind === 'ban' ? { schemaVersion: 1, kind: 'ban', reason: request.operation.reason, deleteMessageSeconds: request.operation.deleteMessageSeconds }
      : { schemaVersion: 1, kind: request.operation.kind, reason: request.operation.reason };
  return createHash('sha256').update(JSON.stringify({ actionId: request.actionId, attemptId: request.attemptId, guildId: request.guildId,
    targetUserId: request.targetUserId, operation, channelId: request.channelId, nonce: request.nonce })).digest('hex');
}

/** The caller owns authorization, durable claiming and retries; this adapter never invents any of those. */
export class DiscordModerationTransport {
  /** Gateway composition supplies its bounded no-retry REST client and current transport availability. */
  constructor(private readonly getClient: () => Client | undefined, private readonly getBotUserId: () => string | undefined,
    private readonly isAvailable: () => boolean, private readonly shutdownSignal: AbortSignal,
    private readonly stateReader: Pick<DiscordStateReader, 'readRelevantAuditEntries'>) {}

  /** Read fresh bot permissions and target hierarchy, resolving only the explicitly requested warning destination. */
  async prepare(input: DiscordModerationPreparationRequest, signal: AbortSignal): Promise<DiscordModerationPreparation> {
    const observedAt = new Date();
    const unavailable: DiscordModerationPreparation = { actionId: input.actionId, guildId: input.guildId, targetUserId: input.targetUserId,
      kind: input.operation.kind, observedAt, complete: false, permitted: false, channelId: null };
    const combined = AbortSignal.any([signal, this.shutdownSignal, AbortSignal.timeout(readTimeoutMs)]);
    try {
      input = { ...input, operation: structuredClone(input.operation) };
      validatePreparation(input);
      const client = this.getClient(), botId = this.getBotUserId();
      if (!client || !botId || !this.available(combined)) return unavailable;
      if (input.operation.kind === 'warning' && input.operation.destination.kind === 'direct_message') {
        // Opening an exact DM is not a warning send, and never authorizes a public fallback.
        const raw = object(await client.rest.post(Routes.userChannels(), { body: { recipient_id: input.targetUserId }, signal: combined }));
        invariant(raw.type === 1 && Array.isArray(raw.recipients) && raw.recipients.length === 1
          && object(raw.recipients[0]).id === input.targetUserId, 'Wrong DM destination');
        assertDiscordId(raw.id as string);
        return this.available(combined) ? { ...unavailable, complete: true, permitted: true, channelId: raw.id as string } : unavailable;
      }
      const targetRead = input.operation.kind === 'ban' || input.operation.kind === 'kick'
        ? this.readMember(client, input.guildId, input.targetUserId, combined) : Promise.resolve(null);
      const channelId = input.operation.kind === 'warning' && input.operation.destination.kind === 'channel' ? input.operation.destination.channelId : null;
      const [guildRaw, rolesRaw, botRaw, targetRaw, channelRaw] = await Promise.all([
        client.rest.get(Routes.guild(input.guildId), { signal: combined }), client.rest.get(Routes.guildRoles(input.guildId), { signal: combined }),
        client.rest.get(Routes.guildMember(input.guildId, botId), { signal: combined }), targetRead,
        channelId ? client.rest.get(Routes.channel(channelId), { signal: combined }) : null,
      ]);
      const guild = object(guildRaw);
      invariant(guild.id === input.guildId, 'Wrong guild'); assertDiscordId(guild.owner_id as string);
      const roles = readRoles(rolesRaw, input.guildId), bot = readMember(botRaw, botId, roles, input.guildId);
      let permitted: boolean;
      if (input.operation.kind === 'warning') {
        const channel = object(channelRaw);
        invariant(channel.id === channelId && channel.guild_id === input.guildId, 'Wrong channel');
        // Threads and voice destinations require further membership/parent facts and are deliberately unavailable here.
        const permissions = channelPermissions(bot, botId, input.guildId, channel);
        permitted = [0, 5].includes(channel.type as number) && !bot.timedOut
          && has(permissions, PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages);
      } else {
        permitted = has(bot.permissions, input.operation.kind === 'kick' ? PermissionFlagsBits.KickMembers : PermissionFlagsBits.BanMembers);
        if (input.operation.kind === 'ban' || input.operation.kind === 'kick') {
          const target = targetRaw === null ? null : readMember(targetRaw, input.targetUserId, roles, input.guildId);
          permitted = permitted && input.targetUserId !== guild.owner_id && input.targetUserId !== botId
            && (target === null ? input.operation.kind === 'ban' : above(bot.highest, target.highest));
        }
      }
      return this.available(combined) ? { ...unavailable, complete: true, permitted, channelId } : unavailable;
    } catch { return unavailable; }
  }

  /** Dispatch exactly once after the owner has durably claimed the attempt; ambiguous failures remain unknown. */
  async execute(request: DiscordModerationRequest, signal: AbortSignal): Promise<DiscordModerationOutcome> {
    /** Record pre-dispatch rejection as definitive; failures after external I/O keep their uncertainty. */
    const failure = (code: string): DiscordModerationOutcome => ({ classification: 'definitive_failure', code });
    try { request = snapshotRequest(request); validateRequest(request); } catch { return failure('invalid_moderation_request'); }
    if (request.claimedAt.getTime() > Date.now() + 5_000 || Date.now() - request.claimedAt.getTime() > 120_000) return failure('moderation_attempt_expired');
    const client = this.getClient(), botId = this.getBotUserId();
    if (!client || !botId || !this.available(signal)) return failure('discord_unavailable');
    const combined = AbortSignal.any([signal, this.shutdownSignal, AbortSignal.timeout(dispatchTimeoutMs)]);
    try {
      if (request.operation.kind === 'ban') {
        await client.rest.put(Routes.guildBan(request.guildId, request.targetUserId), { signal: combined, reason: correlationReason(request),
          body: { delete_message_seconds: request.operation.deleteMessageSeconds } });
      } else if (request.operation.kind === 'unban') {
        await client.rest.delete(Routes.guildBan(request.guildId, request.targetUserId), { signal: combined, reason: correlationReason(request) });
      } else if (request.operation.kind === 'kick') {
        // Discord returns 204 without an action ID; exact attempt correlation supports later audit attribution.
        // https://docs.discord.com/developers/resources/guild#remove-guild-member
        await client.rest.delete(Routes.guildMember(request.guildId, request.targetUserId), { signal: combined, reason: correlationReason(request) });
      } else {
        const response = object(await client.rest.post(Routes.channelMessages(request.channelId!), { signal: combined, body: {
          content: request.operation.text, nonce: request.nonce, enforce_nonce: true, tts: false, flags: MessageFlags.SuppressEmbeds,
          allowed_mentions: { parse: [], users: request.operation.allowedMentions.users, roles: request.operation.allowedMentions.roles, replied_user: false },
        } }));
        if (!exactMessage(response, request, botId)) return { classification: 'unknown', code: 'unexpected_discord_response' };
        return { classification: 'confirmed', code: 'warning_sent', httpStatus: 200, discordMessageId: response.id as string };
      }
      return { classification: 'confirmed', code: request.operation.kind === 'ban' ? 'ban_applied'
        : request.operation.kind === 'kick' ? 'member_kicked' : 'ban_removed', httpStatus: 204 };
    } catch (error) {
      const httpStatus = safeHttpStatus(error);
      // Only a definite rejection proves no external action. An abort, timeout or 5xx may follow acceptance.
      return { classification: httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 ? 'definitive_failure' : 'unknown',
        code: httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 ? 'discord_rejected' : 'discord_outcome_unknown',
        ...(httpStatus === undefined ? {} : { httpStatus }) };
    }
  }

  /** Look for exact attempt attribution; missing evidence never means the action failed and never triggers a send. */
  async reconcile(request: DiscordModerationRequest, signal: AbortSignal): Promise<DiscordModerationReconciliation | null> {
    try {
      request = snapshotRequest(request);
      validateRequest(request);
      const client = this.getClient(), botId = this.getBotUserId();
      if (!client || !botId || !this.available(signal)) return null;
      const combined = AbortSignal.any([signal, this.shutdownSignal, AbortSignal.timeout(readTimeoutMs)]);
      if (request.operation.kind === 'warning') {
        const raw = await client.rest.get(Routes.channelMessages(request.channelId!), { signal: combined, query: new URLSearchParams({ limit: '100' }) });
        invariant(Array.isArray(raw), 'Invalid message history');
        const matches = raw.filter(value => exactMessage(object(value), request, botId));
        if (matches.length !== 1 || !this.available(combined)) return null;
        const reference = object(matches[0]).id as string;
        return { source: 'message_lookup', reference, outcome: { classification: 'confirmed', code: 'warning_reconciled', discordMessageId: reference } };
      }
      const evidence = await this.stateReader.readRelevantAuditEntries({ guildId: request.guildId, actorId: botId,
        targetUserId: request.targetUserId, actionType: auditTypes[request.operation.kind], reason: correlationReason(request),
        after: new Date(request.claimedAt.getTime() - 5_000), before: new Date(request.claimedAt.getTime() + 120_000) }, combined);
      if (!evidence.available || evidence.entries.length !== 1 || !this.available(combined)) return null;
      const reference = evidence.entries[0]!.id;
      return { source: 'discord_audit_log', reference, outcome: { classification: 'confirmed', code: 'moderation_reconciled', discordAuditEntryId: reference } };
    } catch { return null; }
  }

  /** An explicit Discord Unknown Member response alone establishes target absence. */
  private async readMember(client: Client, guildId: string, userId: string, signal: AbortSignal): Promise<unknown | null> {
    try { return await client.rest.get(Routes.guildMember(guildId, userId), { signal }); }
    catch (error) {
      if (safeHttpStatus(error) === 404 && error !== null && typeof error === 'object' && 'code' in error && error.code === 10007) return null;
      throw error;
    }
  }

  /** Both gateway shutdown and per-request cancellation close transport access. */
  private available(signal: AbortSignal): boolean { return this.isAvailable() && !signal.aborted && !this.shutdownSignal.aborted; }
}

/** Validate the bounded transport payload without accepting context entities or caller-claimed authority. */
function validatePreparation(input: DiscordModerationPreparationRequest): void {
  assertUuid(input.actionId); assertDiscordId(input.guildId); assertDiscordId(input.targetUserId);
  const operation = input.operation;
  invariant(operation.schemaVersion === 1, 'Unsupported operation schema');
  if (operation.kind === 'ban' || operation.kind === 'unban' || operation.kind === 'kick') {
    invariant(typeof operation.reason === 'string' && operation.reason.trim().length > 0 && operation.reason.length <= 512, 'Invalid moderation reason');
    if (operation.kind === 'ban') invariant(Number.isInteger(operation.deleteMessageSeconds) && operation.deleteMessageSeconds >= 0
      && operation.deleteMessageSeconds <= 604_800, 'Invalid history deletion');
  } else {
    invariant(operation.kind === 'warning' && typeof operation.text === 'string' && operation.text.trim().length > 0 && operation.text.length <= 2_000, 'Invalid warning');
    invariant(operation.destination.kind === 'direct_message' || operation.destination.kind === 'channel', 'Invalid warning destination');
    if (operation.destination.kind === 'channel') assertDiscordId(operation.destination.channelId);
    invariant(operation.allowedMentions.everyone === false, 'Everyone mentions forbidden');
    for (const ids of [operation.allowedMentions.users, operation.allowedMentions.roles]) {
      invariant(Array.isArray(ids) && ids.length <= 100 && new Set(ids).size === ids.length, 'Invalid allowed mentions'); ids.forEach(assertDiscordId);
    }
  }
}

/** A send binds the concrete destination and payload to an immutable attempt fingerprint. */
function validateRequest(request: DiscordModerationRequest): void {
  validatePreparation(request); assertUuid(request.attemptId);
  invariant(request.claimedAt instanceof Date && Number.isFinite(request.claimedAt.getTime()), 'Invalid attempt timestamp');
  if (request.operation.kind === 'warning') {
    assertDiscordId(request.channelId!);
    invariant(typeof request.nonce === 'string' && /^[a-zA-Z0-9_-]{1,25}$/.test(request.nonce), 'Invalid warning nonce');
    if (request.operation.destination.kind === 'channel') invariant(request.channelId === request.operation.destination.channelId, 'Wrong warning destination');
  } else invariant(request.channelId === null && request.nonce === null, 'Unexpected endpoint destination');
  invariant(request.requestFingerprint === hashDiscordModerationRequest(request), 'Transport fingerprint mismatch');
}

/** Copy every nested mutable value before asynchronous SDK work can observe a caller's later edits. */
function snapshotRequest(request: DiscordModerationRequest): DiscordModerationRequest {
  return { ...request, operation: structuredClone(request.operation), claimedAt: new Date(request.claimedAt.getTime()) };
}

/** Keep audit correlation free of message content or human-supplied text. */
function correlationReason(request: Pick<DiscordModerationRequest, 'actionId' | 'attemptId'>): string { return `yuna:${request.actionId}:${request.attemptId}`; }
/** Accept only JSON objects from Discord. */
function object(value: unknown): Record<string, unknown> { invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid Discord object'); return value as Record<string, unknown>; }
/** Read a bounded role list, refusing missing role identities or malformed permission bitfields. */
function readRoles(value: unknown, guildId: string): Map<string, NativeRole> {
  invariant(Array.isArray(value) && value.length > 0 && value.length <= 1_000, 'Invalid roles');
  const roles = new Map<string, NativeRole>();
  for (const item of value) {
    const role = object(item); assertDiscordId(role.id as string);
    invariant(!roles.has(role.id as string) && Number.isSafeInteger(role.position) && (role.position as number) >= 0, 'Invalid role order');
    roles.set(role.id as string, { id: role.id as string, position: role.position as number, permissions: permissionBits(role.permissions) });
  }
  invariant(roles.has(guildId), 'Missing everyone role'); return roles;
}
/** Compute guild permissions from fresh role facts and preserve timeout state for message permission checks. */
function readMember(value: unknown, userId: string, roles: Map<string, NativeRole>, guildId: string): NativeMember {
  const member = object(value); invariant(object(member.user).id === userId && member.pending !== true && Array.isArray(member.roles), 'Invalid member');
  const ids = [guildId, ...member.roles as string[]]; let permissions = 0n, highest = roles.get(guildId)!;
  for (const id of ids) { assertDiscordId(id); const role = roles.get(id); invariant(role, 'Missing member role'); permissions |= role.permissions; if (above(role, highest)) highest = role; }
  const timeout = member.communication_disabled_until;
  invariant(timeout == null || (typeof timeout === 'string' && Number.isFinite(Date.parse(timeout))), 'Invalid timeout');
  return { roles: ids, permissions, highest, timedOut: typeof timeout === 'string' && Date.parse(timeout) > Date.now() };
}
/** Discord sorts equal role positions by ascending snowflake, and a shared highest role never outranks itself. */
function above(left: NativeRole, right: NativeRole): boolean { return left.position > right.position || (left.position === right.position && BigInt(left.id) < BigInt(right.id)); }
/** Apply everyone, role-union, then member overwrites in Discord's documented order. */
function channelPermissions(member: NativeMember, botId: string, guildId: string, channel: Record<string, unknown>): bigint {
  if (has(member.permissions, PermissionFlagsBits.Administrator)) return member.permissions;
  invariant(Array.isArray(channel.permission_overwrites), 'Missing overwrites');
  const overwrites = channel.permission_overwrites.map(object);
  let result = member.permissions, roleDeny = 0n, roleAllow = 0n;
  for (const overwrite of overwrites) {
    assertDiscordId(overwrite.id as string); invariant(overwrite.type === 0 || overwrite.type === 1, 'Invalid overwrite');
    const deny = permissionBits(overwrite.deny), allow = permissionBits(overwrite.allow);
    if (overwrite.id === guildId && overwrite.type === 0) result = (result & ~deny) | allow;
    else if (overwrite.type === 0 && member.roles.includes(overwrite.id as string)) { roleDeny |= deny; roleAllow |= allow; }
  }
  result = (result & ~roleDeny) | roleAllow;
  const own = overwrites.find(overwrite => overwrite.type === 1 && overwrite.id === botId);
  return own ? (result & ~permissionBits(own.deny)) | permissionBits(own.allow) : result;
}
/** Decimal permission strings avoid unsafe JavaScript number conversions. */
function permissionBits(value: unknown): bigint { invariant(typeof value === 'string' && /^[0-9]{1,40}$/.test(value), 'Invalid permission bits'); return BigInt(value); }
/** Administrator bypasses permission bit checks but is never used to bypass target role hierarchy. */
function has(bits: bigint, required: bigint): boolean { return (bits & PermissionFlagsBits.Administrator) !== 0n || (bits & required) === required; }
/** Bound external status without retaining SDK objects or response bodies. */
function safeHttpStatus(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) return error.status;
  return undefined;
}
/** Only correctly shaped snowflakes may become confirmed references. */
function isDiscordId(value: unknown): value is string { return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value); }
/** Permit bounded service-clock skew and dispatch latency without adopting unrelated older effects. */
function inAttemptWindow(time: number, claimedAt: Date): boolean { return Number.isFinite(time) && time >= claimedAt.getTime() - 5_000 && time <= claimedAt.getTime() + 120_000; }
/** Message attribution requires exact author, destination, nonce, content, and an attempt-bound creation time. */
function exactMessage(message: Record<string, unknown>, request: DiscordModerationRequest, botId: string): boolean {
  return request.operation.kind === 'warning' && isDiscordId(message.id) && message.channel_id === request.channelId
    && object(message.author).id === botId && !message.webhook_id && message.nonce != null && String(message.nonce) === request.nonce
    && typeof message.content === 'string' && createHash('sha256').update(message.content).digest('hex') === createHash('sha256').update(request.operation.text).digest('hex')
    && typeof message.timestamp === 'string' && inAttemptWindow(Date.parse(message.timestamp), request.claimedAt);
}
