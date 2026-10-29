/** Execute one authenticated channel edit/create; uncertain writes are reconciled by audit reason and never blindly repeated. */
import type { AdminChannel } from '../ai/contracts/admin-assistant.contracts.js';
import { PermissionFlagsBits, Routes, type Client } from 'discord.js';
import { assertDiscordId, assertUuid, invariant } from '../platform/db/entity-values.js';
import { DiscordStateReader } from './state-reader.js';
import { validateChannelChore, type ChannelChoreCaller, type ChannelChoreOperation, type ChannelChoreOutcome, type ChannelChoreRequest } from './channel-chore.contracts.js';

interface Channel { id: string; guild_id: string; type: number; name: string; parent_id?: string | null; topic?: string | null; rate_limit_per_user?: number; user_limit?: number }

export class DiscordChannelChoreTransport {
  /** Share the Gateway's authenticated client and availability boundary without exposing SDK objects to owners. */
  constructor(private readonly getClient: () => Client | undefined, private readonly reader: DiscordStateReader,
    private readonly available: () => boolean, private readonly shutdown: AbortSignal) {}

  /** Read fresh metadata for a native administrator, disclosing only the current channel or channels visible to everyone. */
  async readPlanningChannels(caller: ChannelChoreCaller, signal: AbortSignal): Promise<{ channels: AdminChannel[]; directoryPartial: boolean } | null> {
    if (!await this.authorized(caller, signal)) return null;
    const all = await this.channels(caller.guildId, signal), client = this.getClient();
    const visible = all.filter(channel => {
      const cached = client?.channels.cache.get(channel.id);
      return [0, 2, 4].includes(channel.type) && (channel.id === caller.channelId || cached && 'permissionsFor' in cached
        && cached.permissionsFor(caller.guildId)?.has(PermissionFlagsBits.ViewChannel));
    });
    const selected = visible.slice(0, 30);
    return { directoryPartial: selected.length < all.length, channels: selected.map(channel => ({ id: channel.id, name: channel.name,
      type: channel.type as 0 | 2 | 4, parentId: selected.some(c => c.id === channel.parent_id) ? channel.parent_id! : null })) };
  }

  /** Resolve exact channel identity and capture the existing field; ambiguous names never select an arbitrary channel. */
  async prepare(caller: ChannelChoreCaller, request: ChannelChoreRequest, signal: AbortSignal): Promise<ChannelChoreOperation | null> {
    if (!await this.authorized(caller, signal)) return null;
    const channels = await this.channels(caller.guildId, signal);
    if (request.kind === 'create') {
      const name = request.channelType === 0 ? textChannelName(request.name) : request.name;
      if (!name || channels.some(channel => channel.type === request.channelType && channel.name.toLowerCase() === name.toLowerCase())) return null;
      if (request.parentId != null && !channels.some(c => c.id === request.parentId && c.type === 4)) return null;
      const operation = { kind: 'create' as const, channelType: request.channelType, name, ...(request.parentId === undefined ? {} : { parentId: request.parentId }) };
      validateChannelChore(operation); return operation;
    }
    const matches = channels.filter(channel => channel.id === request.channel || channel.name.toLowerCase() === request.channel.toLowerCase());
    if (matches.length !== 1 || ![0, 2, 4].includes(matches[0]!.type)) return null;
    const channel = matches[0]!;
    if (request.kind === 'move' && request.parentId !== null && !channels.some(c => c.id === request.parentId && c.type === 4)) return null;
    const field = request.kind === 'move' ? 'parent_id' : request.kind === 'rename' ? 'name' : request.kind === 'topic' ? 'topic' : request.kind === 'slowmode' ? 'rate_limit_per_user' : 'user_limit';
    const value = request.kind === 'move' ? request.parentId : request.kind === 'rename' ? channel.type === 0 ? textChannelName(request.name) : request.name
      : request.kind === 'topic' ? request.topic : request.kind === 'slowmode' ? request.seconds : request.limit;
    if (value === null && request.kind !== 'move') return null;
    const operation: ChannelChoreOperation = { kind: 'modify', channelId: channel.id, channelType: channel.type as 0 | 2 | 4,
      field, value, previous: channel[field] ?? null };
    validateChannelChore(operation); return operation;
  }

  /** Recheck the real author, unchanged source and exact prior field after the owner has committed its single attempt. */
  async execute(caller: ChannelChoreCaller, operation: ChannelChoreOperation, id: string, signal: AbortSignal,
    mayWrite: () => Promise<boolean>): Promise<ChannelChoreOutcome> {
    validateChannelChore(operation); assertUuid(id);
    const combined = AbortSignal.any([signal, this.shutdown, AbortSignal.timeout(5000)]);
    try {
      if (!await this.authorized(caller, combined)) return { state: 'FAILED', reason: 'administrator_or_source_unavailable' };
      const channels = await this.channels(caller.guildId, combined);
      if (operation.kind === 'modify') {
        const current = channels.find(channel => channel.id === operation.channelId);
        if (!current || current.type !== operation.channelType || (current[operation.field] ?? null) !== operation.previous) return { state: 'FAILED', reason: 'channel_changed' };
      } else if (channels.some(channel => channel.type === operation.channelType && channel.name.toLowerCase() === operation.name.toLowerCase())) {
        return { state: 'FAILED', reason: 'channel_already_exists' };
      }
      const parentId = operation.kind === 'create' ? operation.parentId : operation.field === 'parent_id' ? operation.value : null;
      if (parentId != null && !channels.some(c => c.id === parentId && c.type === 4)) return { state: 'FAILED', reason: 'category_unavailable' };
      if (!await mayWrite() || combined.aborted || !this.available()) return { state: 'FAILED', reason: 'request_no_longer_current' };
    } catch { return { state: 'FAILED', reason: 'preparation_unavailable' }; }
    // https://docs.discord.com/developers/resources/guild#create-guild-channel
    // https://docs.discord.com/developers/resources/channel#modify-channel
    try {
      const client = this.getClient()!;
      const raw = await (operation.kind === 'create'
        ? client.rest.post(Routes.guildChannels(caller.guildId), { body: { name: operation.name, type: operation.channelType, ...(operation.parentId === undefined ? {} : { parent_id: operation.parentId }) }, reason: `yuna:channel-chore:${id}`, signal: combined })
        : client.rest.patch(Routes.channel(operation.channelId), { body: { [operation.field]: operation.value }, reason: `yuna:channel-chore:${id}`, signal: combined })) as Channel;
      assertDiscordId(raw.id);
      if (raw.guild_id !== caller.guildId || raw.type !== operation.channelType
        || (operation.kind === 'create' && operation.parentId != null && raw.parent_id !== operation.parentId)
        || (operation.kind === 'modify' && (raw.id !== operation.channelId || raw[operation.field] !== operation.value))) return { state: 'UNKNOWN', reason: 'unexpected_discord_response' };
      return { state: 'CONFIRMED', channelId: raw.id };
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
      return typeof status === 'number' && status >= 400 && status < 500
        ? { state: 'FAILED', reason: 'discord_rejected' } : { state: 'UNKNOWN', reason: 'discord_outcome_unknown' };
    }
  }

  /** A matching bot audit entry resolves a lost response; an absent audit entry never authorizes retry. */
  async reconcile(guildId: string, operation: ChannelChoreOperation, id: string, startedAt: Date, signal: AbortSignal): Promise<string | null> {
    try {
      assertDiscordId(guildId); assertUuid(id); validateChannelChore(operation);
      const client = this.getClient(), botId = client?.user?.id;
      if (!client || !botId || !this.available()) return null;
      const raw = await client.rest.get(Routes.guildAuditLog(guildId), { signal: AbortSignal.any([signal, this.shutdown, AbortSignal.timeout(5000)]),
        query: new URLSearchParams({ limit: '100', user_id: botId, action_type: operation.kind === 'create' ? '10' : '11' }) }) as { audit_log_entries?: Record<string, unknown>[] };
      if (!Array.isArray(raw.audit_log_entries) || raw.audit_log_entries.length > 100) return null;
      const entries = raw.audit_log_entries.filter(entry => {
        if (entry.user_id !== botId || entry.reason !== `yuna:channel-chore:${id}` || entry.action_type !== (operation.kind === 'create' ? 10 : 11)) return false;
        assertDiscordId(entry.id as string); assertDiscordId(entry.target_id as string);
        const at = Number(BigInt(entry.id as string) >> 22n) + 1420070400000;
        return at >= startedAt.getTime() - 5000 && at <= startedAt.getTime() + 120000
          && (operation.kind === 'create' || entry.target_id === operation.channelId);
      });
      return entries.length === 1 ? entries[0]!.target_id as string : null;
    } catch { return null; }
  }

  /** Native Administrator/owner is mandatory even when an account has Manage Channels or an application grant. */
  private async authorized(caller: ChannelChoreCaller, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.shutdown.aborted || !this.available()) return false;
    const [facts, source] = await Promise.all([
      this.reader.readExecutionFacts({ guildId: caller.guildId, actorId: caller.actorId, sourceRequestId: caller.messageId }, { capability: 'guild.configure' }),
      this.reader.readMessage({ guildId: caller.guildId, channelId: caller.channelId, messageId: caller.messageId }, signal),
    ]);
    return facts.complete && facts.actorIsMember && facts.observedAt.getTime() <= Date.now() && Date.now() - facts.observedAt.getTime() <= 5000
      && (facts.ownerId === caller.actorId || (BigInt(facts.actorPermissions) & PermissionFlagsBits.Administrator) !== 0n)
      && (BigInt(facts.botPermissions) & (PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageChannels)) !== 0n
      && source.state === 'present' && source.sourceHash === caller.sourceHash && source.source?.authorId === caller.actorId
      && !source.source.authorIsBot && !source.source.webhookId && !source.source.system && source.canSend && !signal.aborted && this.available();
  }

  /** One guild-scoped REST page supplies current targets; no private channel metadata is returned to chat. */
  private async channels(guildId: string, signal: AbortSignal): Promise<Channel[]> {
    const value = await this.getClient()!.rest.get(Routes.guildChannels(guildId), { signal: AbortSignal.any([signal, this.shutdown, AbortSignal.timeout(5000)]) });
    invariant(Array.isArray(value) && value.length <= 500, 'Invalid channel directory');
    return value.map((channel: Channel) => { assertDiscordId(channel.id); invariant(channel.guild_id === guildId && typeof channel.name === 'string', 'Wrong channel guild'); return channel; });
  }
}

/** Make text names predictable before dispatch rather than relying on Discord to rewrite the returned name. */
function textChannelName(name: string): string | null {
  const normalized = name.trim().toLowerCase().replace(/\s+/gu, '-');
  return /^[\p{L}\p{N}_-]{1,100}$/u.test(normalized) ? normalized : null;
}
