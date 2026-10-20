import { createHash } from 'node:crypto';
import { assertDiscordId } from '../platform/db/entity-values.js';
import type { MessageReference, NormalizedConversationMessage } from './contracts.js';

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

export function hashDiscordContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function hashMessageSource(source: Pick<ConversationSourceSnapshot,
  'content' | 'editedTimestamp' | 'reference'>): string {
  const reference = source.reference;
  return hashDiscordContent(JSON.stringify([
    source.content, source.editedTimestamp,
    reference ? [reference.guildId, reference.channelId, reference.messageId, reference.type] : null,
  ]));
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
