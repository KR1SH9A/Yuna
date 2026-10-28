/** Bounded same-channel conversation snapshots; these values supply context, never authority or moderation evidence. */
import { createHash } from 'node:crypto';
import { assertDiscordId, invariant } from '../../platform/db/entity-values.js';

export interface ChatContext {
  readonly guildId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly guildName: string;
  readonly channelName: string;
  readonly publicChannels: readonly { id: string; name: string }[];
  readonly directoryPartial: boolean;
  readonly history: 'recent' | 'unavailable';
  readonly messages: readonly {
    id: string; authorId: string; authorName: string; isYuna: boolean; content: string; contentHash: string; createdAt: string;
  }[];
}

/** Copy only explicit fields, preserving exact message hashes and the source's single-channel audience. */
export function prepareChatContext(input: ChatContext): ChatContext {
  for (const id of [input.guildId, input.channelId, input.sourceMessageId]) assertDiscordId(id);
  for (const name of [input.guildName, input.channelName]) invariant(typeof name === 'string' && name.length > 0 && name.length <= 100, 'Invalid channel context name');
  invariant(typeof input.directoryPartial === 'boolean' && ['recent', 'unavailable'].includes(input.history), 'Invalid context coverage');
  invariant(Array.isArray(input.publicChannels) && input.publicChannels.length <= 24 && Array.isArray(input.messages) && input.messages.length <= 8, 'Context count exceeds bound');
  const publicChannels = input.publicChannels.map(channel => {
    assertDiscordId(channel.id);
    invariant(typeof channel.name === 'string' && channel.name.length > 0 && channel.name.length <= 100, 'Invalid channel name');
    return Object.freeze({ id: channel.id, name: channel.name });
  });
  const messages = input.messages.map(message => {
    assertDiscordId(message.id); assertDiscordId(message.authorId);
    invariant(message.id !== input.sourceMessageId && BigInt(message.id) < BigInt(input.sourceMessageId)
      && typeof message.authorName === 'string' && message.authorName.length > 0 && message.authorName.length <= 100
      && typeof message.isYuna === 'boolean' && typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt)), 'Invalid context message');
    invariant(typeof message.content === 'string' && message.content.trim().length > 0 && message.content.length <= 2000
      && message.contentHash === createHash('sha256').update(message.content).digest('hex'), 'Context text binding mismatch');
    return Object.freeze({ id: message.id, authorId: message.authorId, authorName: message.authorName, isYuna: message.isYuna,
      content: message.content, contentHash: message.contentHash, createdAt: message.createdAt });
  });
  invariant(new Set(publicChannels.map(channel => channel.id)).size === publicChannels.length
    && new Set(messages.map(message => message.id)).size === messages.length, 'Duplicate context reference');
  invariant(input.history !== 'unavailable' || messages.length === 0, 'Unavailable history cannot contain messages');
  const result = Object.freeze({ guildId: input.guildId, channelId: input.channelId, sourceMessageId: input.sourceMessageId,
    guildName: input.guildName, channelName: input.channelName, publicChannels: Object.freeze(publicChannels),
    directoryPartial: input.directoryPartial, history: input.history, messages: Object.freeze(messages) });
  invariant(JSON.stringify(result).length <= 5000, 'Context exceeds character bound');
  return result;
}
