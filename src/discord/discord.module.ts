import {
  Client, Events, GatewayIntentBits, MessageFlags, MessageType, Partials, PermissionFlagsBits,
  Routes, type Message, type PartialMessage, type APIMessage,
} from 'discord.js';
import { assertDiscordId } from '../platform/db/entity-values.js';
import type { RuntimeResource } from '../platform/runtime/application.js';
import type {
  DiscordReplyLookup, DiscordReplyRequest, DiscordSendResult, DiscordSourceState,
  MessageReference, NormalizedConversationMessage,
} from './contracts.js';
import {
  hashDiscordContent, hashMessageSource, normalizeConversationMessage, type ConversationSourceSnapshot,
} from './input-normalizer.js';

export interface DiscordGatewayOptions {
  readonly token: string;
  readonly guildId: string;
  readonly onMessage: (message: NormalizedConversationMessage) => void | Promise<void>;
  readonly onInvalidation: (reference: MessageReference) => void | Promise<void>;
  readonly onAvailable?: () => void | Promise<void>;
  readonly onUnavailable?: () => void | Promise<void>;
}

/** The optional factory keeps unit tests offline; SDK types remain inside this integration. */
export interface DiscordGatewayDependencies { readonly createClient: () => Client }

const unavailableSource: DiscordSourceState = Object.freeze({ exists: false, sourceHash: null, canSend: false });
const callbackDrainMs = 5_000;

function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    rest: { retries: 0, timeout: 10_000, rejectOnRateLimit: ['/channels'] },
  });
}

function safeHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = error.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

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

/** One allowlisted guild, text replies only. Durable delivery ownership lives above this class. */
export class DiscordGateway implements RuntimeResource {
  readonly name = 'discord';
  readonly #options: DiscordGatewayOptions;
  readonly #createClient: () => Client;
  readonly #abort = new AbortController();
  readonly #callbacks = new Set<Promise<void>>();
  readonly #normalizing = new Map<string, Set<{ invalidated: boolean }>>();
  #client?: Client;
  #botUserId?: string;
  #available = false;
  #availableCallbackStarted = false;
  #availabilityEpoch = 0;
  #availabilityWork: Promise<void> = Promise.resolve();
  #started = false;
  #stopping?: Promise<void>;

  constructor(options: DiscordGatewayOptions, dependencies: DiscordGatewayDependencies = { createClient }) {
    assertDiscordId(options.guildId);
    this.#options = Object.freeze({ ...options });
    this.#createClient = dependencies.createClient;
  }

  get botUserId(): string {
    if (!this.#botUserId) throw new Error('Discord identity unavailable');
    return this.#botUserId;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.#started || this.#stopping) throw new Error('Discord already started or stopped');
    this.#started = true;
    if (signal.aborted) throw new Error('Discord startup cancelled');
    const client = this.#createClient();
    this.#client = client;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const onAbort = () => rejectReady(new Error('Discord startup cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    client.on(Events.ClientReady, () => {
      if (this.#stopping || signal.aborted) { rejectReady(new Error('Discord startup cancelled')); return; }
      const guild = client.guilds.cache.get(this.#options.guildId);
      if (!client.user || !guild?.available) { rejectReady(new Error('Discord configured guild unavailable')); return; }
      this.#botUserId = client.user.id;
      void this.#restoreAvailability(client).then(() => {
        if (this.#available) resolveReady();
        else rejectReady(new Error('Discord startup cancelled'));
      }, () => rejectReady(new Error('Discord availability update failed')));
    });
    client.on(Events.MessageCreate, message => this.#receive(message));
    client.on(Events.MessageUpdate, (_old, message) => this.#invalidate(message));
    client.on(Events.MessageDelete, message => this.#invalidate(message));
    client.on(Events.MessageBulkDelete, messages => { for (const message of messages.values()) this.#invalidate(message); });
    client.on(Events.ShardDisconnect, () => this.#unavailable());
    client.on(Events.ShardReconnecting, () => this.#unavailable());
    client.on(Events.Invalidated, () => this.#unavailable());
    client.on(Events.Error, () => this.#unavailable());
    client.on(Events.ShardError, () => this.#unavailable());
    client.on(Events.GuildUnavailable, guild => { if (guild.id === this.#options.guildId) this.#unavailable(); });
    client.on(Events.GuildDelete, guild => { if (guild.id === this.#options.guildId) this.#unavailable(); });
    const restore = () => { void this.#restoreAvailability(client).catch(() => {}); };
    client.on(Events.ShardResume, restore);
    client.on(Events.GuildAvailable, guild => { if (guild.id === this.#options.guildId) restore(); });
    try {
      // Handle both rejections immediately, including an early abort while login is in flight.
      await Promise.all([client.login(this.#options.token), ready]);
      if (signal.aborted) throw new Error('Discord startup cancelled');
    } catch { throw new Error('Discord startup failed'); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#available = false;
    this.#abort.abort();
    for (const tokens of this.#normalizing.values()) for (const token of tokens) token.invalidated = true;
    this.#stopping = Promise.resolve().then(async () => {
      this.#notifyUnavailable();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closing = (async () => {
        let failed = false;
        try { await this.#client?.destroy(); } catch { failed = true; }
        await Promise.allSettled([...this.#callbacks]);
        if (failed) throw new Error('Discord shutdown failed');
      })();
      try {
        await Promise.race([closing, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Discord shutdown timed out')), callbackDrainMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    });
    return this.#stopping;
  }

  async readSource(reference: MessageReference, signal: AbortSignal): Promise<DiscordSourceState> {
    const client = this.#client;
    if (!client || !this.#allowed(reference) || signal.aborted || this.#abort.signal.aborted) return unavailableSource;
    const channel = client.channels.cache.get(reference.channelId);
    if (!channel || !('guildId' in channel) || channel.guildId !== this.#options.guildId || !channel.isSendable()) return unavailableSource;
    try {
      const message = await client.rest.get(Routes.channelMessage(reference.channelId, reference.messageId), {
        signal: AbortSignal.any([signal, this.#abort.signal]),
      }) as APIMessage;
      if (!this.#allowed(reference) || signal.aborted || message.id !== reference.messageId || message.channel_id !== reference.channelId
        || typeof message.content !== 'string') return unavailableSource;
      const source = fromRest(message, reference.guildId);
      if (source.editedTimestamp !== null && !Number.isFinite(source.editedTimestamp)) return unavailableSource;
      const permissions = client.user ? channel.permissionsFor(client.user) : null;
      const required: bigint[] = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
        channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages];
      if (channel.isVoiceBased()) required.push(PermissionFlagsBits.Connect);
      const canSend = Boolean(permissions?.has(required)) && !(channel.isThread() && (channel.archived || channel.locked));
      return { exists: true, sourceHash: hashMessageSource(source), canSend };
    } catch { return unavailableSource; }
  }

  async sendReply(request: DiscordReplyRequest, signal: AbortSignal): Promise<DiscordSendResult> {
    const failure = (code: string): DiscordSendResult => ({ classification: 'definitive_failure', code });
    if (!this.#allowed(request)) return failure('discord_unavailable');
    if (typeof request.content !== 'string' || !request.content.trim() || request.content.length > 2_000
      || typeof request.nonce !== 'string' || !/^[1-9][0-9]{0,19}$/.test(request.nonce)
      || request.nonce !== request.messageId) return failure('invalid_reply');
    const deadline = request.deadline instanceof Date ? request.deadline.getTime() : Number.NaN;
    if (!Number.isFinite(deadline) || deadline <= Date.now() || signal.aborted) return failure('reply_expired');
    const deadlineAbort = new AbortController();
    const timer = setTimeout(() => deadlineAbort.abort(), Math.min(deadline - Date.now(), 2_147_483_647));
    const combined = AbortSignal.any([signal, this.#abort.signal, deadlineAbort.signal]);
    try {
      const source = await this.readSource(request, combined);
      if (!source.exists || !source.canSend) return failure('source_unavailable');
      if (request.expectedSourceHash !== undefined && source.sourceHash !== request.expectedSourceHash) return failure('source_changed');
      if (combined.aborted || deadline <= Date.now() || !this.#allowed(request)) return failure('reply_expired');
      // Once POST begins, cancellation/network/5xx cannot prove that Discord did not create the reply.
      try {
        const response = await this.#client!.rest.post(Routes.channelMessages(request.channelId), {
          signal: combined,
          body: {
            content: request.content, nonce: request.nonce, enforce_nonce: true,
            allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
            message_reference: { message_id: request.messageId, channel_id: request.channelId, guild_id: request.guildId, fail_if_not_exists: true },
            tts: false, flags: MessageFlags.SuppressEmbeds,
          },
        }) as APIMessage;
        assertDiscordId(response.id);
        if (response.channel_id !== request.channelId || response.author?.id !== this.#botUserId
          || response.content !== request.content || response.message_reference?.message_id !== request.messageId) {
          return { classification: 'unknown', code: 'unexpected_reply' };
        }
        return { classification: 'delivered', messageId: response.id };
      } catch (error) {
        const httpStatus = safeHttpStatus(error);
        if (httpStatus !== undefined && httpStatus < 500) return { classification: 'definitive_failure', code: 'discord_rejected', httpStatus };
        return { classification: 'unknown', code: 'delivery_unconfirmed', ...(httpStatus === undefined ? {} : { httpStatus }) };
      }
    } finally { clearTimeout(timer); }
  }

  async findReply(request: DiscordReplyLookup, signal: AbortSignal): Promise<string | null> {
    if (!this.#allowed(request) || signal.aborted) return null;
    const channel = this.#client?.channels.cache.get(request.channelId);
    if (!channel || !('guildId' in channel) || channel.guildId !== this.#options.guildId) return null;
    try {
      const messages = await this.#client!.rest.get(Routes.channelMessages(request.channelId), {
        query: new URLSearchParams({ limit: '100' }), signal: AbortSignal.any([signal, this.#abort.signal]),
      }) as APIMessage[];
      if (!this.#allowed(request) || signal.aborted) return null;
      const match = messages.find(message => message.author.id === this.#botUserId && !message.webhook_id
        && message.channel_id === request.channelId && message.nonce === request.nonce
        && message.message_reference?.message_id === request.messageId
        && (message.message_reference.channel_id ?? request.channelId) === request.channelId
        && (message.message_reference.guild_id ?? request.guildId) === request.guildId
        && hashDiscordContent(message.content) === request.contentHash);
      if (!match) return null; // Missing nonce/history is inconclusive; the caller must not infer a failed send.
      assertDiscordId(match.id);
      return match.id;
    } catch { return null; }
  }

  #allowed(reference: MessageReference): boolean {
    if (!this.#available || this.#stopping || reference.guildId !== this.#options.guildId) return false;
    try { for (const id of [reference.guildId, reference.channelId, reference.messageId]) assertDiscordId(id); }
    catch { return false; }
    return true;
  }

  #track(work: Promise<void>): void {
    const safe = work.catch(() => { this.#unavailable(); });
    this.#callbacks.add(safe);
    void safe.finally(() => this.#callbacks.delete(safe));
  }

  #notifyUnavailable(): void {
    this.#availableCallbackStarted = false;
    const callback = this.#availabilityWork.catch(() => {}).then(() => this.#options.onUnavailable?.());
    this.#availabilityWork = callback;
    this.#track(callback);
  }

  #unavailable(): void {
    const wasAvailable = this.#available || this.#availableCallbackStarted;
    this.#available = false;
    this.#availabilityEpoch += 1;
    for (const tokens of this.#normalizing.values()) for (const token of tokens) token.invalidated = true;
    if (wasAvailable && !this.#stopping) this.#notifyUnavailable();
  }

  #restoreAvailability(client: Client): Promise<void> {
    const epoch = this.#availabilityEpoch;
    this.#available = false;
    // Serialize both transitions: an older available write cannot overtake a newer unavailable write.
    const work = this.#availabilityWork.then(async () => {
      if (epoch !== this.#availabilityEpoch || this.#stopping || !client.isReady()
        || !client.guilds.cache.get(this.#options.guildId)?.available) return;
      // The owner may commit availability before this callback settles; a disconnect must follow it with an unavailable write.
      this.#availableCallbackStarted = true;
      await this.#options.onAvailable?.();
      if (epoch === this.#availabilityEpoch && !this.#stopping && client.isReady()
        && client.guilds.cache.get(this.#options.guildId)?.available) this.#available = true;
    });
    this.#availabilityWork = work;
    this.#track(work);
    void work.catch(() => { if (this.#availableCallbackStarted) this.#notifyUnavailable(); });
    return work;
  }

  #invalidate(message: Pick<Message | PartialMessage, 'guildId' | 'channelId' | 'id'>): void {
    if (this.#stopping || message.guildId !== this.#options.guildId) return;
    try { for (const id of [message.guildId, message.channelId, message.id]) assertDiscordId(id); }
    catch { return; }
    for (const token of this.#normalizing.get(message.id) ?? []) token.invalidated = true;
    const reference = { guildId: message.guildId, channelId: message.channelId, messageId: message.id };
    this.#track(Promise.resolve().then(() => this.#options.onInvalidation(reference)));
  }

  #receive(message: Message): void {
    if (!this.#available || this.#stopping || message.guildId !== this.#options.guildId
      || message.author.bot || message.webhookId || message.system) return;
    const reference = { guildId: message.guildId, channelId: message.channelId, messageId: message.id };
    if (!this.#allowed(reference)) return;
    const token = { invalidated: false };
    const tokens = this.#normalizing.get(message.id) ?? new Set<{ invalidated: boolean }>();
    tokens.add(token);
    this.#normalizing.set(message.id, tokens);
    this.#track((async () => {
      try {
        const snapshot: ConversationSourceSnapshot = {
          ...reference, authorId: message.author.id, authorIsBot: message.author.bot,
          webhookId: message.webhookId, system: message.system, content: message.content,
          createdTimestamp: message.createdTimestamp, editedTimestamp: message.editedTimestamp,
          reference: message.reference?.messageId ? {
            guildId: message.reference.guildId ?? reference.guildId, channelId: message.reference.channelId,
            messageId: message.reference.messageId, type: message.reference.type,
          } : null,
          directlyMentionsBot: message.mentions.users.has(this.botUserId) && message.mentions.parsedUsers.has(this.botUserId),
        };
        let previousReply: string | undefined;
        if (message.type === MessageType.Reply && snapshot.reference?.guildId === reference.guildId
          && snapshot.reference.channelId === reference.channelId && this.#allowed(snapshot.reference)) {
          try {
            const previous = await this.#client!.rest.get(Routes.channelMessage(reference.channelId, snapshot.reference.messageId), {
              signal: this.#abort.signal,
            }) as APIMessage;
            if (previous.id === snapshot.reference.messageId && previous.channel_id === reference.channelId
              && previous.author.id === this.botUserId && !previous.webhook_id
              && typeof previous.content === 'string' && previous.content.length <= 4_000) previousReply = previous.content;
          } catch { /* An unavailable reference cannot establish a reply trigger. */ }
        }
        if (token.invalidated || !this.#allowed(reference)) return;
        const normalized = normalizeConversationMessage(snapshot, this.botUserId, previousReply);
        if (normalized) await this.#options.onMessage(normalized);
      } finally {
        tokens.delete(token);
        if (!tokens.size) this.#normalizing.delete(message.id);
      }
    })());
  }
}
