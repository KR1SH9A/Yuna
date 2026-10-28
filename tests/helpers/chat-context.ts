/** Shared bounded chat snapshot with an earlier same-channel message and explicit public channel names. */
import { createHash } from 'node:crypto';
import type { ChatContext } from '../../src/ai/contracts/chat-context.js';

/** Construct data only; callers bind the fixture to their actual guild and triggering message. */
export function chatContext(reference: { guildId: string; channelId: string; messageId: string }): ChatContext {
  const content = 'We are planning a community game night on Friday.';
  return { guildId: reference.guildId, channelId: reference.channelId, sourceMessageId: reference.messageId,
    guildName: 'Community', channelName: 'general', publicChannels: [{ id: reference.channelId, name: 'general' }],
    directoryPartial: false, history: 'recent', messages: [{ id: (BigInt(reference.messageId) - 1n).toString(),
      authorId: '100000000000000099', authorName: 'Sam', isYuna: false, content,
      contentHash: createHash('sha256').update(content).digest('hex'), createdAt: new Date(Date.now() - 1000).toISOString() }] };
}
