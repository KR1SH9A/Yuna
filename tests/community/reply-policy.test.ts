/** Verify public reply policy rejects stale input, audience widening and output that could enable mentions. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { ReplyPolicy } from '../../src/contexts/community/reply.policy.js';
import type { AudienceBinding } from '../../src/contexts/community/contracts.js';

const guildId = '100000000000000001', channelId = '100000000000000002';
const now = new Date();
const input = { guildId, text: 'hello', createdAt: now };
const audience: AudienceBinding = { schemaVersion: 1, channelId, requesterUserId: '100000000000000003', visibility: 'channel', revision: 1 };

test('direct eligibility requires exact guild, supported mode, bounded text and a valid recent date', () => {
  assert.equal(ReplyPolicy.shouldConsiderReply(input, guildId, 'direct', now), true);
  for (const mode of ['silent', 'proactive'] as const) assert.equal(ReplyPolicy.shouldConsiderReply(input, guildId, mode, now), false);
  for (const change of [{ guildId: channelId }, { createdAt: new Date(NaN) }, { createdAt: new Date(now.getTime() - 120_000) },
    { createdAt: new Date(now.getTime() + 30_001) }, { text: ' ' }, { text: 'x'.repeat(4001) }, { previousReply: 'x'.repeat(2001) }]) {
    assert.equal(ReplyPolicy.shouldConsiderReply({ ...input, ...change }, guildId, 'direct', now), false);
  }
});

test('audience checks reject private disclosure, other destinations and changed bindings', () => {
  assert.equal(ReplyPolicy.validateAudience(audience, channelId, { ...audience }), true);
  assert.equal(ReplyPolicy.validateAudience(audience, guildId), false);
  for (const change of [{ visibility: 'requester' as const }, { revision: 2 }, { requesterUserId: guildId }, { channelId: guildId }]) {
    assert.equal(ReplyPolicy.validateAudience({ ...audience, ...change }, channelId, audience), false);
  }
  assert.equal(ReplyPolicy.validateAudience({ ...audience, visibility: 'invented' as 'channel' }, channelId), false);
});

test('output checks allow inert mention text but never enabled mentions or missing accepted content', () => {
  const mentions = { users: [], roles: [], everyone: false as const, repliedUser: false };
  assert.equal(ReplyPolicy.validateReply('@everyone hello', mentions), true);
  for (const value of [null, {}, '', ' ', 'x'.repeat(2001)]) assert.equal(ReplyPolicy.validateReply(value), false);
  for (const value of [null, { ...mentions, users: [guildId] }, { ...mentions, roles: [guildId] }, { ...mentions, repliedUser: true }]) {
    assert.equal(ReplyPolicy.validateReply('hello', value), false);
  }
});
