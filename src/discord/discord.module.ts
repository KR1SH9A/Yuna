/** Own Discord I/O and recover owner callback failures only after durable availability fencing. */
import {
  Client, Events, GatewayIntentBits, MessageFlags, MessageType, Partials, PermissionFlagsBits,
  Routes, ApplicationCommandOptionType, ApplicationCommandType,
  type Message, type PartialMessage, type APIMessage, type Interaction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { assertDiscordId, invariant } from '../platform/db/entity-values.js';
import type { RuntimeResource } from '../platform/runtime/application.js';
import type {
  DiscordReplyLookup, DiscordReplyRequest, DiscordSendResult, DiscordSourceState,
  MessageReference, NormalizedConversationMessage,
  DiscordAuthorityCaller, DiscordAuthorityOperation, DiscordNativeAuthorityFacts, NormalizedAdministrationCommand,
  DiscordOriginalMessageCapture, DiscordOriginalMessageProvenance, DiscordCommandResponse,
} from './contracts.js';
import { discordGrantCapabilities } from './contracts.js';
import { DiscordModerationTransport } from './moderation-transport.js';
import { knowledgeCommandDefinition } from './knowledge-commands.js';
import { memoryCommandDefinition } from './memory-commands.js';
import { debateCommandDefinition } from './debate-commands.js';
import { DiscordDebateTransport } from './debate-transport.js';
import {
  hashDiscordContent, hashMessageSource, normalizeConversationMessage, normalizeAdministrationCommand, normalizeOriginalMessage, type ConversationSourceSnapshot,
} from './input-normalizer.js';

export interface DiscordGatewayOptions {
  readonly token: string;
  readonly guildId: string;
  readonly onMessage: (message: NormalizedConversationMessage) => void | Promise<void>;
  readonly onInvalidation: (reference: MessageReference) => void | Promise<void>;
  readonly onAvailable?: () => void | Promise<void>;
  readonly onUnavailable?: () => void | Promise<void>;
  readonly onCommand?: (command: NormalizedAdministrationCommand) => DiscordCommandResponse | Promise<DiscordCommandResponse>;
  readonly onOriginalMessage?: (provenance: DiscordOriginalMessageProvenance, capture: DiscordOriginalMessageCapture) => void | Promise<void>;
}

/** Static registration payload for the explicit operator setup command; importing it performs no Discord writes. */
export const administrationCommandDefinition: Omit<RESTPostAPIChatInputApplicationCommandsJSONBody, 'contexts' | 'dm_permission' | 'integration_types'> = {
  name: 'yuna', description: 'Manage this server’s Yuna installation', type: ApplicationCommandType.ChatInput,
  // Self-service/report commands are visible to members; each privileged owner still checks current native and application authority.
  default_member_permissions: null,
  options: [
    knowledgeCommandDefinition,
    memoryCommandDefinition,
    debateCommandDefinition,
    { name: 'usage', description: 'View your own usage and remaining limit', type: ApplicationCommandOptionType.Subcommand },
    { name: 'limit-clear', description: 'Clear your own additional personal limit', type: ApplicationCommandOptionType.Subcommand },
    { name: 'limit', description: 'Set a stricter personal daily limit', type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: 'attempts', description: 'Daily attempts, including zero to stop your usage', type: ApplicationCommandOptionType.Integer, min_value: 0, max_value: 1000000 },
        { name: 'amount', description: 'Decimal budget amount; requires currency', type: ApplicationCommandOptionType.String, max_length: 40 },
        { name: 'currency', description: 'Three uppercase currency letters; requires amount', type: ApplicationCommandOptionType.String, min_length: 3, max_length: 3 },
      ] },
    { name: 'action', description: 'Inspect a moderation action’s observed outcome', type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: 'action-id', description: 'Action identifier returned by Yuna', type: ApplicationCommandOptionType.String, required: true, min_length: 36, max_length: 36 }] },
    { name: 'ban', description: 'Request an exact staff ban with an application grant', type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: 'target', description: 'Exact Discord account ID; current membership is not required', type: ApplicationCommandOptionType.String, required: true, max_length: 20 },
        { name: 'reason', description: 'Reason retained with this staff request', type: ApplicationCommandOptionType.String, required: true, max_length: 350 },
        { name: 'delete-seconds', description: 'Explicit message-history deletion window; defaults to zero', type: ApplicationCommandOptionType.Integer, min_value: 0, max_value: 604800 },
      ] },
    { name: 'unban', description: 'Request an exact unban as a current Discord administrator', type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: 'target', description: 'Exact Discord account ID', type: ApplicationCommandOptionType.String, required: true, max_length: 20 },
        { name: 'reason', description: 'Reason retained with this staff request', type: ApplicationCommandOptionType.String, required: true, max_length: 350 },
      ] },
    { name: 'report', description: 'Report a message for review against retained original evidence', type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: 'channel', description: 'Channel containing the message', type: ApplicationCommandOptionType.Channel, required: true },
        { name: 'message-id', description: 'Exact Discord message ID', type: ApplicationCommandOptionType.String, required: true, max_length: 20 },
        { name: 'allegation', description: 'Your report; this does not establish a violation', type: ApplicationCommandOptionType.String, required: true, max_length: 1000 },
      ] },
    { name: 'status', description: 'Inspect Yuna status and current revisions', type: ApplicationCommandOptionType.Subcommand },
    { name: 'bootstrap', description: 'Enroll the current server owner', type: ApplicationCommandOptionType.Subcommand },
    { name: 'configure', description: 'Apply the operator’s local configuration file', type: ApplicationCommandOptionType.Subcommand },
    { name: 'remove', description: 'Begin removing this Yuna installation and its retained data', type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: 'installation-revision', description: 'Installation revision shown by status', type: ApplicationCommandOptionType.Integer, required: true, min_value: 1, max_value: 2_147_483_647 }] },
    { name: 'grant', description: 'Grant an application capability to a user', type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: 'user', description: 'User receiving the capability', type: ApplicationCommandOptionType.User, required: true },
        { name: 'capability', description: 'Application capability; native Discord permissions still apply', type: ApplicationCommandOptionType.String, required: true,
          choices: discordGrantCapabilities.map(value => ({ name: value, value })) },
        { name: 'channel', description: 'Optionally restrict the capability to one channel', type: ApplicationCommandOptionType.Channel },
        { name: 'target', description: 'Optionally restrict the capability to one target member', type: ApplicationCommandOptionType.User },
        { name: 'expires', description: 'Optional UTC expiry such as 2026-12-01T00:00:00Z', type: ApplicationCommandOptionType.String, max_length: 128 },
      ] },
    { name: 'revoke', description: 'Revoke an application grant at its current revisions', type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: 'grant-id', description: 'Internal grant identifier shown by status', type: ApplicationCommandOptionType.String, required: true, max_length: 36 },
        { name: 'authority-revision', description: 'Current grant authority revision', type: ApplicationCommandOptionType.Integer, required: true, min_value: 0, max_value: 2_147_483_647 },
        { name: 'row-revision', description: 'Current grant row revision', type: ApplicationCommandOptionType.Integer, required: true, min_value: 1, max_value: 2_147_483_647 },
        { name: 'reason', description: 'Short reason code using letters, digits, colon, underscore or hyphen', type: ApplicationCommandOptionType.String, required: true, max_length: 128 },
      ] },
    { name: 'pause', description: 'Pause Yuna at the safety revision shown by status', type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: 'safety-revision', description: 'Current safety revision', type: ApplicationCommandOptionType.Integer, required: true, min_value: 0, max_value: 2_147_483_647 },
        { name: 'reason', description: 'Short reason code using letters, digits, colon, underscore or hyphen', type: ApplicationCommandOptionType.String, required: true, max_length: 128 },
      ] },
    { name: 'resume', description: 'Resume Yuna at the safety revision shown by status', type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: 'safety-revision', description: 'Current safety revision', type: ApplicationCommandOptionType.Integer, required: true, min_value: 0, max_value: 2_147_483_647 }] },
    { name: 'channel-status', description: 'Inspect channel reply mode and its current revision', type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: 'channel', description: 'Channel to inspect; defaults to this channel', type: ApplicationCommandOptionType.Channel }] },
    { name: 'channel', description: 'Choose direct replies or silence in a channel', type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: 'channel', description: 'Channel to configure', type: ApplicationCommandOptionType.Channel, required: true },
        { name: 'mode', description: 'Whether explicit mentions and replies receive answers', type: ApplicationCommandOptionType.String, required: true,
          choices: [{ name: 'direct', value: 'direct' }, { name: 'silent', value: 'silent' }] },
        { name: 'row-revision', description: 'Current settings revision, or zero to create settings', type: ApplicationCommandOptionType.Integer, required: true, min_value: 0, max_value: 2_147_483_647 },
      ] },
  ],
};

/** The optional factory keeps unit tests offline; SDK types remain inside this integration. */
export interface DiscordGatewayDependencies { readonly createClient: () => Client }

const unavailableSource: DiscordSourceState = Object.freeze({ exists: false, sourceHash: null, canSend: false });
const callbackDrainMs = 5_000;
const callbackRecoveryMs = 1_000;
const authorityReadMs = 5_000;

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

/** Configure a bounded text-only connection with no automatic message-send retries. */
function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    rest: { retries: 0, timeout: 10_000, rejectOnRateLimit: ['/channels', '/guilds', '/users'] },
  });
}

/** Extract only a public status code; provider errors can contain credentials or message bodies. */
function safeHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = error.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
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
  // A healthy socket can survive a failed database callback. An actual outage still needs
  // an explicit Discord resume/ready event, even when cached SDK readiness has not changed yet.
  #transportAvailable = false;
  #unavailabilityPending = false;
  #availableCallbackStarted = false;
  #availabilityEpoch = 0;
  #availabilityWork: Promise<void> = Promise.resolve();
  #recoveryTimer?: ReturnType<typeof setTimeout>;
  #started = false;
  #stopping?: Promise<void>;

  /** Capture validated scope and injectable SDK creation without opening a connection. */
  constructor(options: DiscordGatewayOptions, dependencies: DiscordGatewayDependencies = { createClient }) {
    assertDiscordId(options.guildId);
    this.#options = Object.freeze({ ...options });
    this.#createClient = dependencies.createClient;
  }

  /** Expose identity only after Discord authenticated the bot. */
  get botUserId(): string {
    if (!this.#botUserId) throw new Error('Discord identity unavailable');
    return this.#botUserId;
  }

  /** Share authenticated transport state with the effect adapter without exposing the SDK client to feature owners. */
  createModerationTransport(): DiscordModerationTransport {
    return new DiscordModerationTransport(() => this.#client, () => this.#botUserId,
      () => this.#available && !this.#stopping, this.#abort.signal);
  }

  /** Give Debate publication the same configured guild and no-retry REST lifecycle as other Discord effects. */
  createDebateTransport(): DiscordDebateTransport {
    return new DiscordDebateTransport(this.#options.guildId, () => this.#client, () => this.#botUserId,
      () => this.#available && !this.#stopping, this.#abort.signal);
  }

  /** Attach lifecycle handlers before login, and wait for both Discord and owner readiness. */
  async start(signal: AbortSignal): Promise<void> {
    if (this.#started || this.#stopping) throw new Error('Discord already started or stopped');
    this.#started = true;
    if (signal.aborted) throw new Error('Discord startup cancelled');
    const client = this.#createClient();
    this.#client = client;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    /** Reject pending startup immediately when application cancellation arrives. */
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
    // Raw dispatch precedes discord.js cache mutation and its conversation MessageCreate event.
    client.on(Events.Raw, (packet: { t?: string; d?: unknown; s?: number }, shardId: number) => {
      if (packet.t === 'MESSAGE_CREATE') this.#receiveOriginal(packet.d, shardId, packet.s);
    });
    client.on(Events.MessageCreate, message => this.#receive(message));
    client.on(Events.InteractionCreate, interaction => this.#receiveInteraction(interaction));
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
    /** Recover persisted availability after reconnect before allowing new Discord work. */
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

  /** Close admission immediately, cancel delayed recovery, and drain callbacks before returning. */
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#available = false;
    this.#transportAvailable = false;
    clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
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

  /** Read current content and local permission facts; missing or uncertain access fails closed. */
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

  /** Recheck the source, send once, and preserve uncertainty once the external POST begins. */
  async sendReply(request: DiscordReplyRequest, signal: AbortSignal): Promise<DiscordSendResult> {
    /** Represent a pre-dispatch rejection as definitive because no Discord request was sent. */
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

  /** Return only exact attributable evidence; absent recent history cannot prove no send. */
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

  /** Read native authority directly from REST, outside transactions; missing or changed facts never grant permission. */
  async readFacts<Operation extends DiscordAuthorityOperation>(caller: DiscordAuthorityCaller, operation: Operation): Promise<DiscordNativeAuthorityFacts<Operation>> {
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
    const epoch = this.#availabilityEpoch;
    const reads = new AbortController();
    const signal = AbortSignal.any([this.#abort.signal, reads.signal, AbortSignal.timeout(authorityReadMs)]);
    try {
      for (const id of [actorId, guildId, sourceRequestId, ...(selected.channelId === undefined ? [] : [selected.channelId]), ...(selected.targetUserId === undefined ? [] : [selected.targetUserId])]) assertDiscordId(id);
      if (!this.#client || !this.#botUserId || !this.#available || this.#stopping || guildId !== this.#options.guildId
        || !['administration.manage', ...discordGrantCapabilities].includes(selected.capability)) return unavailable;
      const client = this.#client, botId = this.#botUserId;
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
      if (signal.aborted || !this.#available || this.#stopping || epoch !== this.#availabilityEpoch) return unavailable;
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

  /** Acknowledge only authenticated in-guild /yuna commands; keep interaction tokens inside the SDK adapter. */
  #receiveInteraction(interaction: Interaction): void {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'yuna'
      || interaction.guildId !== this.#options.guildId || interaction.applicationId !== this.#client?.application?.id
      || interaction.user.bot || interaction.deferred || interaction.replied || this.#stopping) return;
    const command = normalizeAdministrationCommand({ actorId: interaction.user.id, actorIsBot: interaction.user.bot,
      guildId: interaction.guildId, channelId: interaction.channelId ?? '', sourceRequestId: interaction.id,
      commandName: interaction.commandName, options: interaction.options.data });
    const epoch = this.#availabilityEpoch;
    this.#track((async () => {
      // Defer before database/native-authority work so the acknowledgement meets Discord's deadline.
      try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); }
      catch { return; } // A failed/duplicate acknowledgement never authorizes the command callback.
      let content = 'Yuna is temporarily unavailable. Try again after checking its status.';
      let attachment: { filename: string; content: string } | undefined;
      if (!command) content = 'Invalid Yuna command arguments. Use the registered command options.';
      else if (this.#available && epoch === this.#availabilityEpoch && !this.#stopping && this.#options.onCommand) {
        try {
          const response = await this.#options.onCommand(command);
          const text = typeof response === 'string' ? response : response.content;
          const file = typeof response === 'string' ? undefined : response.attachment;
          const validFile = file === undefined || (typeof file.filename === 'string' && /^[a-z][a-z0-9-]{0,63}\.json$/.test(file.filename)
            && typeof file.content === 'string' && Buffer.byteLength(file.content, 'utf8') <= 64 * 1024);
          if (typeof text === 'string' && text.trim().length > 0 && text.length <= 2_000 && validFile) { content = text; attachment = file; }
          else content = 'The command completed without a displayable response. Check Yuna status.';
        } catch {
          // A command may already have committed. Never replay it or expose exceptions in Discord.
          content = 'The command outcome could not be confirmed. Check Yuna status before trying again.';
        }
      }
      if (this.#stopping) return;
      try { await interaction.editReply({ content, allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
        ...(attachment ? { files: [{ attachment: Buffer.from(attachment.content, 'utf8'), name: attachment.filename }] } : {}) }); }
      catch { /* Lost private response does not retry the operation or close conversation intake. */ }
    })());
  }

  /** Restrict every read/effect to the configured guild while all readiness gates are open. */
  #allowed(reference: MessageReference): boolean {
    if (!this.#available || this.#stopping || reference.guildId !== this.#options.guildId) return false;
    try { for (const id of [reference.guildId, reference.channelId, reference.messageId]) assertDiscordId(id); }
    catch { return false; }
    return true;
  }

  /** Drain owner work on stop, and treat callback rejection as an observation gap, not a socket loss. */
  #track(work: Promise<void>): void {
    const safe = work.catch(() => { this.#unavailable(false); });
    this.#callbacks.add(safe);
    void safe.finally(() => this.#callbacks.delete(safe));
  }

  /** Serialize the durable fence; retain its obligation until a write for this epoch succeeds. */
  #notifyUnavailable(): void {
    const epoch = this.#availabilityEpoch;
    this.#unavailabilityPending = true;
    this.#availableCallbackStarted = false;
    const callback = this.#availabilityWork.catch(() => {}).then(async () => {
      await this.#options.onUnavailable?.();
      if (epoch === this.#availabilityEpoch) this.#unavailabilityPending = false;
    });
    this.#availabilityWork = callback;
    this.#track(callback);
  }

  /** Fence new work synchronously; transport loss can be cleared only by a Discord readiness event. */
  #unavailable(transportLost = true): void {
    const wasAvailable = this.#available || this.#availableCallbackStarted;
    this.#available = false;
    if (transportLost) this.#transportAvailable = false;
    this.#availabilityEpoch += 1;
    for (const tokens of this.#normalizing.values()) for (const token of tokens) token.invalidated = true;
    if (wasAvailable && !this.#stopping) this.#notifyUnavailable();
    this.#scheduleRecovery();
  }

  /** Keep one delayed retry, with no tight loop or callback overlap while storage is unavailable. */
  #scheduleRecovery(): void {
    if (this.#stopping || this.#abort.signal.aborted || this.#recoveryTimer
      || (!this.#unavailabilityPending && !this.#transportAvailable)) return;
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = undefined;
      if (this.#client && !this.#stopping) void this.#restoreAvailability(this.#client, false).catch(() => {});
    }, callbackRecoveryMs);
  }

  /** Retry failed fences before resume; a stale callback can never reopen a newer outage or shutdown. */
  #restoreAvailability(client: Client, transportRestored = true): Promise<void> {
    if (transportRestored) this.#transportAvailable = true;
    clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    const epoch = this.#availabilityEpoch;
    this.#available = false;
    // Serialize both transitions: an older available write cannot overtake a newer unavailable write.
    const work = this.#availabilityWork.catch(() => {}).then(async () => {
      if (epoch !== this.#availabilityEpoch || this.#stopping) return;
      if (this.#unavailabilityPending) {
        await this.#options.onUnavailable?.();
        if (epoch !== this.#availabilityEpoch || this.#stopping) return;
        this.#unavailabilityPending = false;
      }
      if (!this.#transportAvailable || !client.isReady()
        || !client.guilds.cache.get(this.#options.guildId)?.available) return;
      // The owner may commit availability before this callback settles; a disconnect must follow it with an unavailable write.
      this.#availableCallbackStarted = true;
      await this.#options.onAvailable?.();
      if (epoch === this.#availabilityEpoch && !this.#stopping && this.#transportAvailable && client.isReady()
        && client.guilds.cache.get(this.#options.guildId)?.available) this.#available = true;
    });
    this.#availabilityWork = work;
    this.#track(work);
    return work;
  }

  /** Invalidate identity immediately, including messages whose reply verification is still awaiting REST. */
  #invalidate(message: Pick<Message | PartialMessage, 'guildId' | 'channelId' | 'id'>): void {
    if (this.#stopping || message.guildId !== this.#options.guildId) return;
    try { for (const id of [message.guildId, message.channelId, message.id]) assertDiscordId(id); }
    catch { return; }
    for (const token of this.#normalizing.get(message.id) ?? []) token.invalidated = true;
    const reference = { guildId: message.guildId, channelId: message.channelId, messageId: message.id };
    this.#track(Promise.resolve().then(() => this.#options.onInvalidation(reference)));
  }

  /** Snapshot every in-scope create independently; owner storage deduplicates IDs and callback failures never suppress Community. */
  #receiveOriginal(payload: unknown, shardId: number, gatewaySequence?: number): void {
    if (!this.#available || this.#stopping || !this.#botUserId || !this.#options.onOriginalMessage) return;
    const original = normalizeOriginalMessage(payload, { botUserId: this.#botUserId,
      hasMessageContent: this.#client?.options.intents.has(GatewayIntentBits.MessageContent) === true,
      observedAt: new Date(), shardId, ...(gatewaySequence === undefined ? {} : { gatewaySequence }) });
    if (!original || !this.#allowed(original.provenance)) return;
    this.#track((async () => {
      try { await this.#options.onOriginalMessage!(original.provenance, original.capture); }
      catch { /* Composition owns safe operational reporting; uncertain intake is never replayed here. */ }
    })());
  }

  /** Normalize eligible messages, verifying reply authors before handing bounded text to Community. */
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
