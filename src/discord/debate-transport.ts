/** Publish accepted Debate summaries through Discord once, with fresh channel access and exact message reconciliation. */
import { createHash } from 'node:crypto';
import { MessageFlags, PermissionFlagsBits, Routes, type Client } from 'discord.js';
import { assertDate, assertDiscordId, assertUuid, invariant } from '../platform/db/entity-values.js';

export interface DiscordDebatePublication {
  readonly guildId: string; readonly channelId: string; readonly evaluationId: string;
  readonly content: string; readonly nonce: string; readonly contentHash: string; readonly deadline: Date;
}
export type DiscordDebateLookup = Omit<DiscordDebatePublication, 'content' | 'deadline'>;
export type DiscordDebateOutcome = { readonly classification: 'confirmed'; readonly messageId: string }
  | { readonly classification: 'rejected' | 'unknown'; readonly code: string };

/** A failed observation is retryable before claim and must not be mistaken for a confirmed permission denial. */
class PublicationReadUnavailable extends Error {
  /** Retain only a fixed diagnostic, never the raw Discord error, request or credentials. */
  constructor() { super('Publication access could not be observed'); }
}

export class DiscordDebateTransport {
  /** Reuse Gateway's no-retry REST client; installation identity never comes from a provider response. */
  constructor(private readonly guildId: string, private readonly getClient: () => Client | undefined,
    private readonly getBotUserId: () => string | undefined, private readonly isAvailable: () => boolean,
    private readonly shutdownSignal: AbortSignal) { assertDiscordId(guildId); }

  /** Observe current bot roles and exact channel overwrites before the owner claims a publication. */
  async prepare(input: { guildId: string; channelId: string }, signal: AbortSignal): Promise<{ allowed: boolean; observedAt: Date }> {
    const observedAt = new Date();
    try {
      const permissions = await this.readAccess({ ...input }, signal);
      return { allowed: has(permissions, PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages), observedAt };
    } catch (error) {
      if (error instanceof PublicationReadUnavailable) throw error;
      return { allowed: false, observedAt };
    }
  }

  /** Validate the committed payload, recheck access and issue one POST; an ambiguous POST is never retried. */
  async send(input: DiscordDebatePublication, signal: AbortSignal): Promise<DiscordDebateOutcome> {
    let request: DiscordDebatePublication;
    try {
      request = { ...input, deadline: new Date(input.deadline) }; this.validateLookup(request);
      assertDate(request.deadline, 'publication deadline');
      invariant(typeof request.content === 'string' && request.content.length > 0 && request.content.length <= 2000
        && hash(request.content) === request.contentHash, 'Invalid publication content');
    } catch { return { classification: 'rejected', code: 'invalid_publication' }; }
    const client = this.getClient(), botId = this.getBotUserId();
    if (!client || !botId || !this.available(signal) || request.deadline.getTime() <= Date.now()) return { classification: 'rejected', code: 'publication_unavailable' };
    const combined = AbortSignal.any([signal, this.shutdownSignal,
      AbortSignal.timeout(Math.max(1, Math.min(10000, request.deadline.getTime() - Date.now())))]);
    let access: { allowed: boolean; observedAt: Date };
    try { access = await this.prepare(request, combined); }
    catch { return { classification: 'rejected', code: 'publication_preflight_unavailable' }; }
    if (!access.allowed || !this.available(combined) || request.deadline.getTime() <= Date.now()) return { classification: 'rejected', code: 'publication_access_denied' };
    try {
      const response = await client.rest.post(Routes.channelMessages(request.channelId), { signal: combined, body: {
        content: request.content, nonce: request.nonce, enforce_nonce: true, tts: false, flags: MessageFlags.SuppressEmbeds,
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
      } });
      return exactMessage(response, request, botId) ? { classification: 'confirmed', messageId: object(response).id as string }
        : { classification: 'unknown', code: 'unexpected_publication_response' };
    } catch (error) {
      const status = error !== null && typeof error === 'object' && 'status' in error ? error.status : undefined;
      const rejected = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500 && status !== 408;
      return { classification: rejected ? 'rejected' : 'unknown', code: rejected ? 'discord_rejected' : 'publication_outcome_unknown' };
    }
  }

  /** Resolve only one own message with the committed channel, nonce and content hash; absence remains unknown. */
  async reconcile(input: DiscordDebateLookup, signal: AbortSignal): Promise<string | null> {
    try {
      const request = { ...input }; this.validateLookup(request);
      const client = this.getClient(), botId = this.getBotUserId();
      if (!client || !botId || !this.available(signal)) return null;
      const combined = AbortSignal.any([signal, this.shutdownSignal, AbortSignal.timeout(5000)]);
      if (!has(await this.readAccess(request, combined), PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory)) return null;
      const response = await client.rest.get(Routes.channelMessages(request.channelId), { signal: combined, query: new URLSearchParams({ limit: '100' }) });
      invariant(Array.isArray(response) && response.length <= 100, 'Invalid publication history');
      const matches = response.filter(value => exactMessage(value, request, botId));
      return matches.length === 1 && this.available(combined) ? object(matches[0]).id as string : null;
    } catch { return null; }
  }

  /** Require the configured guild, exact record identity and owner-derived nonce before any external call. */
  private validateLookup(input: DiscordDebateLookup): void {
    assertDiscordId(input.guildId); assertDiscordId(input.channelId); assertUuid(input.evaluationId);
    invariant(input.guildId === this.guildId && /^[a-f0-9]{64}$/.test(input.contentHash)
      && input.nonce === hash(`debate:${input.evaluationId}`).slice(0, 24), 'Invalid publication identity');
  }

  /** Fetch fresh REST facts instead of relying on cached guild roles or channel permission calculations. */
  private async readAccess(input: { guildId: string; channelId: string }, signal: AbortSignal): Promise<bigint> {
    assertDiscordId(input.guildId); assertDiscordId(input.channelId);
    invariant(input.guildId === this.guildId, 'Wrong publication guild');
    const client = this.getClient(), botId = this.getBotUserId();
    if (!client || !botId || !this.available(signal)) throw new PublicationReadUnavailable();
    const combined = AbortSignal.any([signal, this.shutdownSignal, AbortSignal.timeout(5000)]);
    const [guildRaw, rolesRaw, memberRaw, channelRaw] = await remoteRead(Promise.all([
      client.rest.get(Routes.guild(input.guildId), { signal: combined }), client.rest.get(Routes.guildRoles(input.guildId), { signal: combined }),
      client.rest.get(Routes.guildMember(input.guildId, botId), { signal: combined }), client.rest.get(Routes.channel(input.channelId), { signal: combined }),
    ]));
    if (!this.available(combined)) throw new PublicationReadUnavailable();
    const guild = object(guildRaw), member = object(memberRaw), channel = object(channelRaw);
    invariant(guild.id === input.guildId && channel.id === input.channelId && channel.guild_id === input.guildId
      && [0, 5].includes(channel.type as number) && object(member.user).id === botId && member.pending !== true
      && Array.isArray(member.roles) && member.roles.length <= 1000 && Array.isArray(rolesRaw) && rolesRaw.length <= 1000, 'Invalid publication destination');
    if (member.communication_disabled_until != null) invariant(typeof member.communication_disabled_until === 'string'
      && Date.parse(member.communication_disabled_until) <= Date.now(), 'Bot is timed out');
    const roles = new Map<string, bigint>();
    for (const value of rolesRaw) { const role = object(value); assertDiscordId(role.id as string);
      invariant(!roles.has(role.id as string), 'Duplicate role'); roles.set(role.id as string, bits(role.permissions)); }
    invariant(roles.has(input.guildId), 'Missing everyone role');
    let permissions = roles.get(input.guildId)!;
    const ownedRoles = new Set<string>();
    for (const role of member.roles) { assertDiscordId(role as string); invariant(roles.has(role as string), 'Missing member role'); ownedRoles.add(role as string); permissions |= roles.get(role as string)!; }
    if (guild.owner_id === botId || (permissions & PermissionFlagsBits.Administrator) !== 0n) return PermissionFlagsBits.Administrator;
    invariant(Array.isArray(channel.permission_overwrites) && channel.permission_overwrites.length <= 1000, 'Missing channel overwrites');
    let everyoneAllow = 0n, everyoneDeny = 0n, roleAllow = 0n, roleDeny = 0n, memberAllow = 0n, memberDeny = 0n;
    const seen = new Set<string>();
    for (const value of channel.permission_overwrites) {
      const overwrite = object(value); assertDiscordId(overwrite.id as string); invariant(overwrite.type === 0 || overwrite.type === 1, 'Invalid overwrite');
      const key = `${overwrite.type}:${overwrite.id}`; invariant(!seen.has(key), 'Duplicate overwrite'); seen.add(key);
      const allow = bits(overwrite.allow), deny = bits(overwrite.deny);
      if (overwrite.type === 0 && overwrite.id === input.guildId) { everyoneAllow = allow; everyoneDeny = deny; }
      else if (overwrite.type === 0 && ownedRoles.has(overwrite.id as string)) { roleAllow |= allow; roleDeny |= deny; }
      else if (overwrite.type === 1 && overwrite.id === botId) { memberAllow = allow; memberDeny = deny; }
    }
    return (((permissions & ~everyoneDeny | everyoneAllow) & ~roleDeny | roleAllow) & ~memberDeny) | memberAllow;
  }

  /** Availability and cancellation are checked again after asynchronous reads before a side effect begins. */
  private available(signal: AbortSignal): boolean { return !signal.aborted && !this.shutdownSignal.aborted && this.isAvailable(); }
}

/** Replace transport read failures with a safe retryable signal before any publication claim is made. */
async function remoteRead<T>(work: Promise<T>): Promise<T> { try { return await work; } catch { throw new PublicationReadUnavailable(); } }

/** Decode only bounded unsigned bitfields, retaining every permission bit exactly. */
function bits(value: unknown): bigint { invariant(typeof value === 'string' && /^[0-9]{1,40}$/.test(value), 'Invalid permissions'); return BigInt(value); }
/** Administrator bypasses channel overwrites; every other required bit must be present. */
function has(value: bigint, required: bigint): boolean { return (value & PermissionFlagsBits.Administrator) !== 0n || (value & required) === required; }
/** Hash exact UTF-8 text so reconciliation cannot accept a similarly worded summary. */
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
/** Restrict external values to object shapes before reading identities or permission fields. */
function object(value: unknown): Record<string, unknown> { invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid Discord object'); return value as Record<string, unknown>; }
/** Positive evidence must bind the bot author, ordinary message type, exact destination, nonce and complete text. */
function exactMessage(value: unknown, request: DiscordDebateLookup, botId: string): boolean {
  try { const message = object(value); assertDiscordId(message.id as string);
    return message.channel_id === request.channelId && object(message.author).id === botId && !message.webhook_id && message.type === 0
      && message.nonce === request.nonce && typeof message.content === 'string' && hash(message.content) === request.contentHash;
  } catch { return false; }
}
