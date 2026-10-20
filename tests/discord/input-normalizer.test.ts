import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import {
  hashMessageSource, normalizeConversationMessage, type ConversationSourceSnapshot,
} from '../../src/discord/input-normalizer.js';

const botId = '100000000000000001';
const source: ConversationSourceSnapshot = {
  guildId: '100000000000000002', channelId: '100000000000000003', messageId: '100000000000000004',
  authorId: '100000000000000005', authorIsBot: false, system: false,
  content: `<@${botId}> hello <@!${botId}> <@100000000000000006>`,
  createdTimestamp: 1_700_000_000_000, editedTimestamp: null, reference: null, directlyMentionsBot: true,
};

test('normalization removes only self mentions, keeps provenance and hashes the full source', () => {
  const result = normalizeConversationMessage(source, botId);
  assert.ok(result);
  assert.equal(result.text, 'hello  <@100000000000000006>');
  assert.equal(result.authorId, source.authorId);
  assert.equal(result.createdAt.getTime(), source.createdTimestamp);
  assert.equal(result.sourceHash, hashMessageSource(source));
  assert.equal(result.previousReply, undefined);
  assert.ok(Object.isFrozen(result));
  const changedSpacing = normalizeConversationMessage({ ...source, content: `${source.content} ` }, botId);
  assert.equal(changedSpacing?.text, result.text);
  assert.notEqual(changedSpacing?.sourceHash, result.sourceHash);
});

test('normalization rejects nonhuman sources, missing triggers, invalid IDs and unusable content', () => {
  const rejected: ConversationSourceSnapshot[] = [
    { ...source, authorIsBot: true }, { ...source, webhookId: '100000000000000007' },
    { ...source, system: true }, { ...source, authorId: botId }, { ...source, directlyMentionsBot: false },
    { ...source, guildId: 'not-an-id' }, { ...source, messageId: '18446744073709551616' },
    { ...source, content: `<@${botId}>  ` }, { ...source, content: 'x'.repeat(4_001) },
    { ...source, createdTimestamp: Number.NaN }, { ...source, editedTimestamp: Number.NaN },
  ];
  for (const input of rejected) assert.equal(normalizeConversationMessage(input, botId), null);
  assert.ok(normalizeConversationMessage({ ...source, content: 'x'.repeat(4_000) }, botId));
});

test('verified prior reply is a separate trigger and is bounded', () => {
  const reply = { ...source, content: 'follow up', directlyMentionsBot: false };
  assert.equal(normalizeConversationMessage(reply, botId), null);
  assert.equal(normalizeConversationMessage(reply, botId, 'Earlier answer')?.previousReply, 'Earlier answer');
  assert.equal(normalizeConversationMessage(reply, botId, 'x'.repeat(4_001)), null);
});

test('source revision hash detects edit timestamps and changed reference identity', () => {
  const hash = hashMessageSource(source);
  assert.notEqual(hashMessageSource({ ...source, editedTimestamp: source.createdTimestamp + 1 }), hash);
  const reference = { guildId: source.guildId, channelId: source.channelId, messageId: '100000000000000008', type: 0 };
  assert.notEqual(hashMessageSource({ ...source, reference }), hash);
  assert.notEqual(hashMessageSource({ ...source, reference }), hashMessageSource({ ...source, reference: { ...reference, type: 1 } }));
});
