/** Read bounded current Discord facts; absence, unavailable access and attributable evidence stay distinct. */
import { GatewayIntentBits, MessageType, PermissionFlagsBits, Routes, type APIMessage, type Client } from 'discord.js';
import { assertDiscordId, invariant } from '../platform/db/entity-values.js';
import { discordGrantCapabilities, type DiscordAuthorityCaller, type DiscordAuthorityOperation,
  type DiscordNativeAuthorityFacts, type MessageReference } from './contracts.js';
import { hashMessageSource, type ConversationSourceSnapshot } from './input-normalizer.js';

export interface DiscordStateReaderDependencies {
  readonly getClient: () => Client | undefined;
  readonly getBotUserId: () => string | undefined;
  readonly isAvailable: () => boolean;
  readonly getEpoch: () => number;
  readonly shutdownSignal: AbortSignal;
}
/** Current text only, never an original-evidence replacement or an attachment capture. */
export interface DiscordMessageRead extends MessageReference {
  readonly observedAt: Date;
  readonly state: 'present' | 'missing' | 'unavailable';
  readonly contentAccess: 'available' | 'restricted' | 'missing';
  readonly source: ConversationSourceSnapshot | null;
  readonly sourceHash: string | null;
  readonly canSend: boolean;
}
export interface DiscordBanRead {
  readonly guildId: string; readonly userId: string; readonly observedAt: Date;
  readonly state: 'banned' | 'not_banned' | 'unavailable';
}
export interface DiscordAuditReadRequest {
  readonly guildId: string; readonly actorId: string; readonly targetUserId: string;
  readonly actionType: 20 | 22 | 23; readonly reason: string;
  readonly after: Date; readonly before: Date;
}
export interface DiscordAuditRead {
  readonly observedAt: Date; readonly available: boolean;
  /** One bounded page is evidence only; an empty page never proves an effect did not happen. */
  readonly entries: readonly { readonly id: string; readonly createdAt: Date }[];
}
const readTimeoutMs = 5_000;

/** Recognize exact absence errors only; generic 404, forbidden and network failures remain unknown. */
function isUnknown(error: unknown, code: number): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
    && 'code' in error && error.code === code;
}
/** Keep credential-bearing SDK error objects behind the adapter boundary. */
function safeHttpStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}
interface NativeRole { readonly id: string; readonly position: number; readonly permissions: string }
interface NativeMember { readonly permissions: string; readonly highest: NativeRole; readonly pending: boolean }

/** Reduce a fresh member/role response to guild permission bits and the highest comparable role. */
function nativeMember(value: unknown, userId: string, guildId: string, roles: ReadonlyMap<string, NativeRole>): NativeMember {
  invariant(value !== null && typeof value === 'object', 'Missing Discord member');
  const member = value as { user?: { id?: unknown }; roles?: unknown; pending?: unknown };
  invariant(member.user?.id === userId && Array.isArray(member.roles) && member.roles.length <= 1_000, 'Invalid Discord member');
  invariant(member.pending === undefined || typeof member.pending === 'boolean', 'Invalid member screening state');
  let highest = roles.get(guildId)!;
  let permissions = BigInt(highest.permissions);
  for (const id of member.roles) {
    invariant(typeof id === 'string' && roles.has(id), 'Unknown Discord role');
    const role = roles.get(id)!;
    permissions |= BigInt(role.permissions);
    if (role.position > highest.position || (role.position === highest.position && BigInt(role.id) < BigInt(highest.id))) highest = role;
  }
  return { permissions: permissions.toString(), highest, pending: member.pending === true };
}

/** Convert a fresh REST message to the same source snapshot used by Gateway intake. */
function fromRest(message: APIMessage, guildId: string): ConversationSourceSnapshot {
  const reference = message.message_reference;
  return {
    guildId, channelId: message.channel_id, messageId: message.id, authorId: message.author.id,
    authorIsBot: message.author.bot ?? false, webhookId: message.webhook_id,
    system: message.type !== MessageType.Default && message.type !== MessageType.Reply,
    content: message.content, createdTimestamp: Date.parse(message.timestamp),
    editedTimestamp: message.edited_timestamp === null ? null : Date.parse(message.edited_timestamp),
    reference: reference?.message_id ? {
      guildId: reference.guild_id ?? guildId, channelId: reference.channel_id ?? message.channel_id,
      messageId: reference.message_id, type: reference.type ?? 0,
    } : null,
    directlyMentionsBot: false,
  };
}

/** One configured guild and the Gateway's availability epoch fence every asynchronous read. */
export class DiscordStateReader {
  /** Capture lifecycle readers without retaining a stale SDK session or starting network work. */
  constructor(private readonly guildId: string, private readonly dependencies: DiscordStateReaderDependencies) { assertDiscordId(guildId); }

  /** Fetch current message text and local send permissions; REST cannot reconstruct deleted or pre-edit originals. */
  async readMessage(input: MessageReference, signal: AbortSignal): Promise<DiscordMessageRead> {
    const reference = { guildId: input.guildId, channelId: input.channelId, messageId: input.messageId };
    const unavailable: DiscordMessageRead = { ...reference, observedAt: new Date(), state: 'unavailable', contentAccess: 'missing', source: null, sourceHash: null, canSend: false };
    const epoch = this.dependencies.getEpoch();
    const combined = AbortSignal.any([signal, this.dependencies.shutdownSignal, AbortSignal.timeout(readTimeoutMs)]);
    try {
      for (const id of Object.values(reference)) assertDiscordId(id);
      const client = this.dependencies.getClient();
      if (!client || !this.current(reference.guildId, epoch, combined)) return unavailable;
      const channel = client.channels.cache.get(reference.channelId);
      if (!channel || !('guildId' in channel) || channel.guildId !== this.guildId || !channel.isSendable()) return unavailable;
      const message = await client.rest.get(Routes.channelMessage(reference.channelId, reference.messageId), { signal: combined }) as APIMessage;
      if (!this.current(reference.guildId, epoch, combined)) return unavailable;
      invariant(message.id === reference.messageId && message.channel_id === reference.channelId && typeof message.content === 'string', 'Wrong source message');
      assertDiscordId(message.author.id);
      const source = fromRest(message, reference.guildId);
      invariant(Number.isFinite(source.createdTimestamp) && (source.editedTimestamp === null || Number.isFinite(source.editedTimestamp)), 'Invalid message timestamp');
      // Message-content access also has per-message exceptions. Without the intent, retain no text rather than infer full coverage.
      // https://docs.discord.com/developers/resources/message#get-channel-message
      if (!client.options.intents.has(GatewayIntentBits.MessageContent)) return { ...unavailable, state: 'present', contentAccess: 'restricted' };
      const permissions = client.user ? channel.permissionsFor(client.user) : null;
      const required: bigint[] = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
        channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages];
      if (channel.isVoiceBased()) required.push(PermissionFlagsBits.Connect);
      const canSend = Boolean(permissions?.has(required)) && !(channel.isThread() && (channel.archived || channel.locked));
      return { ...unavailable, state: 'present', contentAccess: 'available', source, sourceHash: hashMessageSource(source), canSend };
    } catch (error) {
      return isUnknown(error, 10008) && this.current(reference.guildId, epoch, combined) ? { ...unavailable, state: 'missing' } : unavailable;
    }
  }

  /** Observe current ban state without attributing it to Yuna or any prior attempt. */
  async readBan(input: { guildId: string; userId: string }, signal: AbortSignal): Promise<DiscordBanRead> {
    const guildId = input.guildId, userId = input.userId;
    const unavailable: DiscordBanRead = { guildId, userId, observedAt: new Date(), state: 'unavailable' };
    const epoch = this.dependencies.getEpoch();
    const combined = AbortSignal.any([signal, this.dependencies.shutdownSignal, AbortSignal.timeout(readTimeoutMs)]);
    try {
      assertDiscordId(guildId); assertDiscordId(userId);
      const client = this.dependencies.getClient();
      if (!client || !this.current(guildId, epoch, combined)) return unavailable;
      // https://docs.discord.com/developers/resources/guild#get-guild-ban
      const raw = await client.rest.get(Routes.guildBan(guildId, userId), { signal: combined }) as { user?: { id?: unknown } };
      return raw?.user?.id === userId && this.current(guildId, epoch, combined) ? { ...unavailable, state: 'banned' } : unavailable;
    } catch (error) {
      return isUnknown(error, 10026) && this.current(guildId, epoch, combined) ? { ...unavailable, state: 'not_banned' } : unavailable;
    }
  }

  /** Fetch at most 100 audit entries and return only exact actor, target, operation, reason and time matches. */
  async readRelevantAuditEntries(input: DiscordAuditReadRequest, signal: AbortSignal): Promise<DiscordAuditRead> {
    const { guildId, actorId, targetUserId, actionType, reason } = input;
    const unavailable: DiscordAuditRead = { observedAt: new Date(), available: false, entries: [] };
    const epoch = this.dependencies.getEpoch();
    const combined = AbortSignal.any([signal, this.dependencies.shutdownSignal, AbortSignal.timeout(readTimeoutMs)]);
    try {
      const after = input.after.getTime(), before = input.before.getTime();
      for (const id of [guildId, actorId, targetUserId]) assertDiscordId(id);
      invariant([20, 22, 23].includes(actionType) && typeof reason === 'string' && reason.length > 0 && reason.length <= 512, 'Invalid audit scope');
      invariant(Number.isFinite(after) && Number.isFinite(before) && after <= before && before - after <= 125_000, 'Audit window must be bounded');
      const client = this.dependencies.getClient();
      if (!client || !this.current(guildId, epoch, combined)) return unavailable;
      // https://docs.discord.com/developers/resources/audit-log#get-guild-audit-log
      const raw = await client.rest.get(Routes.guildAuditLog(guildId), { signal: combined,
        query: new URLSearchParams({ limit: '100', user_id: actorId, action_type: String(actionType) }) }) as { audit_log_entries?: unknown };
      invariant(Array.isArray(raw?.audit_log_entries) && raw.audit_log_entries.length <= 100, 'Invalid audit log');
      const entries: { id: string; createdAt: Date }[] = [];
      for (const value of raw.audit_log_entries) {
        invariant(value !== null && typeof value === 'object', 'Invalid audit entry');
        const entry = value as Record<string, unknown>;
        if (entry.user_id !== actorId || entry.target_id !== targetUserId || entry.action_type !== actionType || entry.reason !== reason) continue;
        assertDiscordId(entry.id as string);
        const time = Number(BigInt(entry.id as string) >> 22n) + 1_420_070_400_000;
        if (time >= after && time <= before) entries.push({ id: entry.id as string, createdAt: new Date(time) });
      }
      return this.current(guildId, epoch, combined) ? { ...unavailable, available: true, entries } : unavailable;
    } catch { return unavailable; }
  }

  /** Reject reads spanning a disconnect, even when the same client has already reconnected. */
  private current(guildId: string, epoch: number, signal: AbortSignal): boolean {
    return guildId === this.guildId && this.dependencies.isAvailable() && epoch === this.dependencies.getEpoch()
      && !signal.aborted && !this.dependencies.shutdownSignal.aborted;
  }
  /** Read native authority directly from REST, outside transactions; missing or changed facts never grant permission. */
  async readExecutionFacts<Operation extends DiscordAuthorityOperation>(caller: DiscordAuthorityCaller, operation: Operation): Promise<DiscordNativeAuthorityFacts<Operation>> {
    const actorId = caller.actorId, guildId = caller.guildId, sourceRequestId = caller.sourceRequestId;
    const selected = Object.freeze({ capability: operation.capability,
      ...(operation.channelId === undefined ? {} : { channelId: operation.channelId }),
      ...(operation.targetUserId === undefined ? {} : { targetUserId: operation.targetUserId }) });
    // Measure freshness from the first read, not the end of a potentially slow multi-request observation.
    const observedAt = new Date();
    const unavailable: DiscordNativeAuthorityFacts<Operation> = Object.freeze({
      actorId, guildId, sourceRequestId, operation: selected, observedAt, complete: false,
      ownerId: '', actorIsMember: false, actorPermissions: '0', botPermissions: '0',
    });
    const epoch = this.dependencies.getEpoch();
    const reads = new AbortController();
    const signal = AbortSignal.any([this.dependencies.shutdownSignal, reads.signal, AbortSignal.timeout(readTimeoutMs)]);
    try {
      for (const id of [actorId, guildId, ...(selected.channelId === undefined ? [] : [selected.channelId]), ...(selected.targetUserId === undefined ? [] : [selected.targetUserId])]) assertDiscordId(id);
      invariant(typeof sourceRequestId === 'string' && sourceRequestId.length > 0 && sourceRequestId.length <= 200, 'Invalid authority request reference');
      if (signal.aborted || !this.dependencies.getClient() || !this.dependencies.getBotUserId() || !this.dependencies.isAvailable() || guildId !== this.guildId
        || !['administration.manage', ...discordGrantCapabilities].includes(selected.capability)) return unavailable;
      const client = this.dependencies.getClient()!, botId = this.dependencies.getBotUserId()!;
      // Only an explicit Unknown Member response proves absence; forbidden/timeouts remain incomplete.
      /** Fetch current membership and treat only Discord’s exact Unknown Member response as absence. */
      const member = async (userId: string): Promise<unknown | null> => {
        try { return await client.rest.get(Routes.guildMember(guildId, userId), { signal }); }
        catch (error) {
          if (safeHttpStatus(error) === 404 && typeof error === 'object' && error !== null && 'code' in error && error.code === 10007) return null;
          throw error;
        }
      };
      const [rawGuild, rawRoles, rawActor, rawBot, rawTarget, rawChannel] = await Promise.all([
        client.rest.get(Routes.guild(guildId), { signal }), client.rest.get(Routes.guildRoles(guildId), { signal }),
        member(actorId), member(botId), selected.targetUserId ? member(selected.targetUserId) : null,
        selected.channelId ? client.rest.get(Routes.channel(selected.channelId), { signal }) : null,
      ]);
      if (signal.aborted || !this.dependencies.isAvailable() || epoch !== this.dependencies.getEpoch()) return unavailable;
      invariant(rawGuild !== null && typeof rawGuild === 'object', 'Missing guild facts');
      const guild = rawGuild as { id?: unknown; owner_id?: unknown };
      invariant(guild.id === guildId, 'Wrong guild facts');
      assertDiscordId(guild.owner_id as string);
      if (selected.channelId) {
        invariant(rawChannel !== null && typeof rawChannel === 'object', 'Missing channel facts');
        const channel = rawChannel as { id?: unknown; guild_id?: unknown };
        invariant(channel.id === selected.channelId && channel.guild_id === guildId, 'Channel outside guild');
      }
      invariant(Array.isArray(rawRoles) && rawRoles.length > 0 && rawRoles.length <= 1_000, 'Missing guild roles');
      const roles = new Map<string, NativeRole>();
      for (const value of rawRoles) {
        invariant(value !== null && typeof value === 'object', 'Invalid guild role');
        const role = value as NativeRole;
        assertDiscordId(role.id);
        invariant(!roles.has(role.id) && Number.isSafeInteger(role.position) && role.position >= 0
          && typeof role.permissions === 'string' && /^[0-9]{1,40}$/.test(role.permissions), 'Invalid guild role');
        roles.set(role.id, { id: role.id, position: role.position, permissions: role.permissions });
      }
      invariant(roles.has(guildId), 'Missing everyone role');
      const actor = rawActor === null ? null : nativeMember(rawActor, actorId, guildId, roles);
      const bot = nativeMember(rawBot, botId, guildId, roles);
      invariant(!bot.pending, 'Bot membership incomplete');
      const target = rawTarget === null || selected.targetUserId === undefined ? null : nativeMember(rawTarget, selected.targetUserId, guildId, roles);
      // Equal positions follow Discord's snowflake ordering; equal highest roles never outrank one another.
      /** Compare current highest roles using Discord’s position and snowflake ordering rules. */
      const aboveTarget = (subject: NativeMember | null) => Boolean(subject && target &&
        (subject.highest.position > target.highest.position || (subject.highest.position === target.highest.position && BigInt(subject.highest.id) < BigInt(target.highest.id))));
      return Object.freeze({ actorId, guildId, sourceRequestId, operation: selected, observedAt, complete: true,
        ownerId: guild.owner_id as string, actorIsMember: actor !== null && !actor.pending,
        actorPermissions: actor?.permissions ?? '0', botPermissions: bot.permissions,
        ...(selected.targetUserId ? { target: Object.freeze({ userId: selected.targetUserId, isMember: target !== null,
          isGuildOwner: selected.targetUserId === guild.owner_id, isSelf: selected.targetUserId === botId,
          actorAboveTarget: aboveTarget(actor), botAboveTarget: aboveTarget(bot) }) } : {}),
      });
    } catch { return unavailable; }
    finally { reads.abort(); }
  }

}
