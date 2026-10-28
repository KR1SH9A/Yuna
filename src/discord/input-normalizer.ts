/** Normalize conversational text and allowlisted operator commands without trusting caller-supplied identity. */
import { createHash } from 'node:crypto';
import { normalizeKnowledgeCommand } from './knowledge-commands.js';
import { normalizeMemoryCommand } from './memory-commands.js';
import { normalizeDebateCommand } from './debate-commands.js';
import { assertDiscordId, assertUuid, invariant } from '../platform/db/entity-values.js';
import { discordGrantCapabilities, type DiscordCommandIdentity, type DiscordOriginalMessageCapture, type DiscordOriginalMessageProvenance, type MessageReference,
  type NormalizedAdministrationCommand, type NormalizedConversationMessage } from './contracts.js';

/** SDK/REST adapters supply this snapshot; fetching and reply verification happen outside here. */
export interface ConversationSourceSnapshot extends MessageReference {
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly webhookId?: string | null;
  readonly system: boolean;
  readonly content: string;
  readonly createdTimestamp: number;
  readonly editedTimestamp: number | null;
  readonly reference: (MessageReference & { readonly type: number }) | null;
  readonly directlyMentionsBot: boolean;
}

/** Fingerprint exact content without retaining another payload copy. */
export function hashDiscordContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Include edits and reply identity so matching normalized text cannot conceal a changed source. */
export function hashMessageSource(source: Pick<ConversationSourceSnapshot,
  'content' | 'editedTimestamp' | 'reference'>): string {
  const reference = source.reference;
  return hashDiscordContent(JSON.stringify([
    source.content, source.editedTimestamp,
    reference ? [reference.guildId, reference.channelId, reference.messageId, reference.type] : null,
  ]));
}

/** Preserve the raw create payload before SDK caching; absent/restricted content cannot masquerade as an empty body. */
export function normalizeOriginalMessage(
  payload: unknown,
  context: { readonly botUserId: string; readonly hasMessageContent: boolean; readonly observedAt: Date;
    readonly shardId?: number; readonly gatewaySequence?: number },
): { readonly provenance: DiscordOriginalMessageProvenance; readonly capture: DiscordOriginalMessageCapture } | null {
  try {
    invariant(payload !== null && typeof payload === 'object' && !Array.isArray(payload), 'Missing original event');
    const source = payload as Record<string, unknown>;
    for (const id of [source.guild_id, source.channel_id, source.id, context.botUserId]) assertDiscordId(id as string);
    invariant(Number.isInteger(source.type) && (source.type as number) >= 0 && (source.type as number) <= 2_147_483_647
      && Number.isFinite(context.observedAt.getTime()), 'Invalid original provenance');
    const missing = new Set<string>();
    let authorUserId: string | null = null, webhookId: string | null = null;
    let authorKind: DiscordOriginalMessageProvenance['authorKind'] = 'unknown';
    const author = source.author !== null && typeof source.author === 'object' ? source.author as Record<string, unknown> : null;
    if (source.webhook_id !== undefined && source.webhook_id !== null) {
      try { assertDiscordId(source.webhook_id as string); webhookId = source.webhook_id as string; authorKind = 'webhook'; }
      catch { missing.add('webhook_identity_missing'); }
    } else if (![0, 19, 20, 23].includes(source.type as number)) authorKind = 'system';
    else {
      try {
        assertDiscordId(author?.id as string);
        invariant(author?.bot === undefined || typeof author.bot === 'boolean', 'Invalid author kind');
        authorUserId = author!.id as string;
        authorKind = author?.bot === true ? 'bot' : 'user';
      } catch { missing.add('author_identity_missing'); }
    }
    const createdTime = typeof source.timestamp === 'string' && source.timestamp.length <= 64 ? Date.parse(source.timestamp) : Number.NaN;
    const createdAt = Number.isFinite(createdTime) ? new Date(createdTime) : null;
    if (!createdAt) missing.add('source_timestamp_missing');
    const mentioned = Array.isArray(source.mentions) && source.mentions.some(value => value !== null
      && typeof value === 'object' && (value as { id?: unknown }).id === context.botUserId);
    const accessible = context.hasMessageContent || author?.id === context.botUserId || mentioned;
    const edited = source.edited_timestamp !== undefined && source.edited_timestamp !== null;
    let contentAccess: DiscordOriginalMessageCapture['contentAccess'] = accessible ? 'available' : 'restricted';
    let originalContent: string | null = null;
    if (!accessible) missing.add('message_content_restricted');
    else if (edited) { contentAccess = 'missing'; missing.add('edited_create_not_original'); }
    else if (typeof source.content !== 'string') { contentAccess = 'missing'; missing.add('original_content_missing'); }
    else if (source.content.length > 100_000) { contentAccess = 'missing'; missing.add('original_content_exceeds_bound'); }
    else originalContent = source.content;
    const attachments: DiscordOriginalMessageCapture['attachments'][number][] = [];
    let attachmentsComplete = accessible && !edited && Array.isArray(source.attachments) && source.attachments.length <= 100;
    if (!attachmentsComplete) missing.add('attachment_metadata_incomplete');
    if (accessible && !edited && Array.isArray(source.attachments)) {
      const ids = new Set<string>();
      for (const value of source.attachments.slice(0, 100)) {
        try {
          invariant(value !== null && typeof value === 'object', 'Invalid attachment');
          const attachment = value as Record<string, unknown>;
          assertDiscordId(attachment.id as string);
          invariant(!ids.has(attachment.id as string) && typeof attachment.filename === 'string' && attachment.filename.length <= 1_024
            && Number.isSafeInteger(attachment.size) && (attachment.size as number) >= 0
            && (attachment.content_type === undefined || attachment.content_type === null || (typeof attachment.content_type === 'string' && attachment.content_type.length <= 255))
            && (attachment.description === undefined || attachment.description === null || (typeof attachment.description === 'string' && attachment.description.length <= 4_096)), 'Invalid attachment metadata');
          ids.add(attachment.id as string);
          attachments.push(Object.freeze({ id: attachment.id as string, filename: attachment.filename,
            contentType: (attachment.content_type as string | undefined | null) ?? null, byteSize: attachment.size as number,
            description: (attachment.description as string | undefined | null) ?? null }));
        } catch { attachmentsComplete = false; missing.add('attachment_metadata_incomplete'); }
      }
    }
    return Object.freeze({
      provenance: Object.freeze({ guildId: source.guild_id as string, channelId: source.channel_id as string, messageId: source.id as string,
        eventKind: 'message_create', authorKind, authorUserId, webhookId, messageType: source.type as number,
        createdAt, observedAt: new Date(context.observedAt),
        ...(Number.isSafeInteger(context.shardId) && context.shardId! >= 0 ? { shardId: context.shardId } : {}),
        ...(Number.isSafeInteger(context.gatewaySequence) && context.gatewaySequence! >= 0 ? { gatewaySequence: context.gatewaySequence } : {}) }),
      capture: Object.freeze({ originalContent, attachments: Object.freeze(attachments), contentAccess,
        attachmentsComplete, missingReasons: Object.freeze([...missing]) }),
    });
  } catch { return null; }
}

/** Only an actual create snapshot is admitted; updates merely invalidate pending work. */
export function normalizeConversationMessage(
  source: ConversationSourceSnapshot,
  botUserId: string,
  verifiedPreviousReply?: string,
): NormalizedConversationMessage | null {
  try {
    for (const id of [source.guildId, source.channelId, source.messageId, source.authorId, botUserId]) assertDiscordId(id);
    if (source.reference) {
      for (const id of [source.reference.guildId, source.reference.channelId, source.reference.messageId]) assertDiscordId(id);
    }
  } catch { return null; }
  if (source.authorIsBot || source.webhookId || source.system || source.authorId === botUserId) return null;
  if (!source.directlyMentionsBot && verifiedPreviousReply === undefined) return null;
  if (typeof source.content !== 'string' || !Number.isFinite(source.createdTimestamp)
    || !Number.isFinite(new Date(source.createdTimestamp).getTime())
    || (source.editedTimestamp !== null && !Number.isFinite(source.editedTimestamp))) return null;
  // IDs have already been checked as decimal strings, so they cannot introduce regex syntax.
  const text = source.content.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim();
  if (!text || text.length > 4_000) return null;
  if (verifiedPreviousReply !== undefined && (typeof verifiedPreviousReply !== 'string' || verifiedPreviousReply.length > 4_000)) return null;
  return Object.freeze({
    guildId: source.guildId, channelId: source.channelId, messageId: source.messageId,
    authorId: source.authorId, text, createdAt: new Date(source.createdTimestamp),
    sourceHash: hashMessageSource(source),
    ...(verifiedPreviousReply === undefined ? {} : { previousReply: verifiedPreviousReply }),
  });
}

/** Minimal SDK snapshot; option values remain untrusted until the command-specific allowlist accepts them. */
export interface AdministrationCommandSnapshot extends DiscordCommandIdentity {
  readonly commandName: string;
  readonly actorIsBot: boolean;
  readonly options: readonly {
    readonly name: string; readonly type: number; readonly value?: unknown;
    readonly options?: readonly { readonly name: string; readonly type: number; readonly value?: unknown; readonly options?: unknown }[];
  }[];
}

/** Parse one /yuna subcommand; identifiers for actor/guild/request are copied only from authenticated ingress. */
export function normalizeAdministrationCommand(source: AdministrationCommandSnapshot): NormalizedAdministrationCommand | null {
  try {
    for (const id of [source.actorId, source.guildId, source.channelId, source.sourceRequestId]) assertDiscordId(id);
    if (source.commandName !== 'yuna' || source.actorIsBot || !Array.isArray(source.options) || source.options.length !== 1) return null;
    const selected: AdministrationCommandSnapshot['options'][number] = source.options[0]!;
    if (selected.type === 2 && selected.name === 'knowledge') return normalizeKnowledgeCommand(source);
    if (selected.type === 2 && selected.name === 'memory') return normalizeMemoryCommand(source, selected);
    if (selected.type === 2 && selected.name === 'debate') return normalizeDebateCommand(source, selected);
    if (selected.type !== 1 || selected.value !== undefined || !['status', 'bootstrap', 'configure', 'remove', 'grant', 'revoke', 'pause', 'resume', 'channel', 'channel-status', 'ban', 'unban', 'report', 'action', 'usage', 'limit', 'limit-clear'].includes(selected.name)) return null;
    const entries = selected.options ?? [];
    if (!Array.isArray(entries) || entries.length > 5) return null;
    const values = new Map<string, { type: number; value?: unknown }>();
    for (const entry of entries) {
      if (entry.options !== undefined || values.has(entry.name)) return null;
      values.set(entry.name, entry);
    }
    const allowedOptions: Readonly<Record<string, readonly string[]>> = {
      status: [], bootstrap: [], configure: [], remove: ['installation-revision'], grant: ['user', 'capability', 'channel', 'target', 'expires'],
      revoke: ['grant-id', 'authority-revision', 'row-revision', 'reason'],
      pause: ['safety-revision', 'reason'], resume: ['safety-revision'], channel: ['channel', 'mode', 'row-revision'],
      'channel-status': ['channel'],
      ban: ['target', 'reason', 'delete-seconds'], unban: ['target', 'reason'], report: ['channel', 'message-id', 'allegation'],
      action: ['action-id'], usage: [], limit: ['attempts', 'amount', 'currency'], 'limit-clear': [],
    };
    const allowed = allowedOptions[selected.name]!;
    if ([...values.keys()].some(key => !allowed.includes(key))) return null;
    const identity = { actorId: source.actorId, guildId: source.guildId, channelId: source.channelId, sourceRequestId: source.sourceRequestId };
    let command: NormalizedAdministrationCommand;
    switch (selected.name) {
      case 'action': {
        const actionId = readCommandOption(values, 'action-id', 3) as string; assertUuid(actionId);
        command = { ...identity, command: 'action', arguments: Object.freeze({ actionId }) }; break;
      }
      case 'limit': {
        const dailyAttemptLimit = values.has('attempts') ? readCommandOption(values, 'attempts', 4) as number : undefined;
        invariant(dailyAttemptLimit === undefined || dailyAttemptLimit <= 1_000_000, 'Invalid personal limit');
        const amount = values.has('amount') ? readCommandOption(values, 'amount', 3) as string : undefined;
        const currency = values.has('currency') ? readCommandOption(values, 'currency', 3) as string : undefined;
        invariant((amount === undefined) === (currency === undefined), 'Budget requires amount and currency');
        invariant(amount === undefined || (/^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/.test(amount) && /^[A-Z]{3}$/.test(currency!)), 'Invalid currency budget');
        invariant(dailyAttemptLimit !== undefined || amount !== undefined, 'Missing personal limit');
        command = { ...identity, command: 'limit', arguments: Object.freeze({ ...(dailyAttemptLimit !== undefined ? { dailyAttemptLimit } : {}),
          ...(amount !== undefined ? { dailyBudget: Object.freeze({ amount, currency: currency! }) } : {}) }) }; break;
      }
      case 'ban': case 'unban': {
        const targetUserId = readCommandOption(values, 'target', 3) as string;
        assertDiscordId(targetUserId);
        const reason = readCommandOption(values, 'reason', 3, 0, 350) as string;
        invariant(reason.trim().length > 0 && !/[\p{Cc}]/u.test(reason), 'Invalid sanction reason');
        if (selected.name === 'ban') {
          const deleteMessageSeconds = values.has('delete-seconds') ? readCommandOption(values, 'delete-seconds', 4) as number : 0;
          invariant(deleteMessageSeconds <= 604800, 'History deletion exceeds seven days');
          command = { ...identity, command: 'ban', arguments: Object.freeze({ targetUserId, reason, deleteMessageSeconds }) };
        } else command = { ...identity, command: 'unban', arguments: Object.freeze({ targetUserId, reason }) };
        break;
      }
      case 'report': {
        const channelId = readCommandOption(values, 'channel', 7) as string, messageId = readCommandOption(values, 'message-id', 3) as string;
        assertDiscordId(channelId); assertDiscordId(messageId);
        const allegation = readCommandOption(values, 'allegation', 3, 0, 1000) as string;
        invariant(allegation.trim().length > 0, 'Missing allegation');
        command = { ...identity, command: 'report', arguments: Object.freeze({ channelId, messageId, allegation }) };
        break;
      }
      case 'status': case 'bootstrap': case 'configure': case 'usage': case 'limit-clear':
        command = { ...identity, command: selected.name, arguments: Object.freeze({}) };
        break;
      case 'remove':
        command = { ...identity, command: 'remove', arguments: Object.freeze({ expectedInstallationRevision: readCommandOption(values, 'installation-revision', 4, 1) as number }) };
        break;
      case 'grant': {
        const granteeUserId = readCommandOption(values, 'user', 6) as string;
        assertDiscordId(granteeUserId);
        const capability = readCommandOption(values, 'capability', 3) as typeof discordGrantCapabilities[number];
        invariant(discordGrantCapabilities.includes(capability), 'Unsupported capability');
        const channel = values.has('channel') ? readCommandOption(values, 'channel', 7) as string : undefined;
        const target = values.has('target') ? readCommandOption(values, 'target', 6) as string : undefined;
        if (channel) assertDiscordId(channel);
        if (target) assertDiscordId(target);
        const expiry = values.has('expires') ? readCommandOption(values, 'expires', 3) as string : undefined;
        invariant(expiry === undefined || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiry) && Number.isFinite(Date.parse(expiry))
          && new Date(expiry).toISOString().slice(0, 19) === expiry.slice(0, 19)), 'Invalid expiry');
        command = { ...identity, command: 'grant', arguments: Object.freeze({ granteeUserId, capability,
          scope: Object.freeze({ channelIds: Object.freeze(channel ? [channel] : []), targetUserIds: Object.freeze(target ? [target] : []) }),
          sourceOperationKey: `discord:${source.sourceRequestId}`, expiresAt: expiry === undefined ? null : new Date(expiry).toISOString() }) };
        break;
      }
      case 'revoke': {
        const grantId = readCommandOption(values, 'grant-id', 3) as string;
        assertUuid(grantId);
        command = { ...identity, command: 'revoke', arguments: Object.freeze({ grantId,
          expectedAuthorityRevision: readCommandOption(values, 'authority-revision', 4) as number,
          expectedRowRevision: readCommandOption(values, 'row-revision', 4, 1) as number,
          reasonCode: readCommandOption(values, 'reason', 3) as string }) };
        break;
      }
      case 'pause':
        command = { ...identity, command: 'pause', arguments: Object.freeze({
          expectedSafetyRevision: readCommandOption(values, 'safety-revision', 4) as number,
          reasonCode: readCommandOption(values, 'reason', 3) as string }) };
        break;
      case 'resume':
        command = { ...identity, command: 'resume', arguments: Object.freeze({ expectedSafetyRevision: readCommandOption(values, 'safety-revision', 4) as number }) };
        break;
      case 'channel-status': {
        const channelId = values.has('channel') ? readCommandOption(values, 'channel', 7) as string : source.channelId;
        assertDiscordId(channelId);
        command = { ...identity, command: 'channel-status', arguments: Object.freeze({ channelId }) };
        break;
      }
      default: {
        const channelId = readCommandOption(values, 'channel', 7) as string;
        assertDiscordId(channelId);
        const mode = readCommandOption(values, 'mode', 3) as 'silent' | 'direct';
        invariant(mode === 'silent' || mode === 'direct', 'Unsupported channel mode');
        command = { ...identity, command: 'channel', arguments: Object.freeze({ channelId, mode,
          expectedRowRevision: readCommandOption(values, 'row-revision', 4) as number }) };
      }
    }
    if ('reasonCode' in command.arguments) invariant(/^[a-zA-Z0-9:_-]{1,128}$/.test(command.arguments.reasonCode), 'Invalid reason');
    return Object.freeze(command);
  } catch { return null; }
}

/** Check the Discord option type and bounds before converting it into a business DTO field. */
function readCommandOption(values: ReadonlyMap<string, { type: number; value?: unknown }>, name: string, type: number, minimum = 0, maximumLength = 128): string | number {
  const option = values.get(name);
  invariant(option?.type === type, 'Missing or incorrectly typed command option');
  if (type === 4) {
    invariant(typeof option.value === 'number' && Number.isSafeInteger(option.value) && option.value >= minimum && option.value <= 2_147_483_647, 'Invalid revision');
    return option.value;
  }
  invariant(typeof option.value === 'string' && option.value.length > 0 && option.value.length <= maximumLength, 'Invalid command text');
  return option.value;
}
