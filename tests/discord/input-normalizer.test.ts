/** Verify bounded conversation and command snapshots without provider, database or Discord access. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import {
  hashMessageSource, normalizeConversationMessage, normalizeAdministrationCommand, normalizeOriginalMessage,
  type AdministrationCommandSnapshot, type ConversationSourceSnapshot,
} from '../../src/discord/input-normalizer.js';

const botId = '100000000000000001';
const source: ConversationSourceSnapshot = {
  guildId: '100000000000000002', channelId: '100000000000000003', messageId: '100000000000000004',
  authorId: '100000000000000005', authorIsBot: false, system: false,
  content: `<@${botId}> hello <@!${botId}> <@100000000000000006>`,
  createdTimestamp: 1_700_000_000_000, editedTimestamp: null, reference: null, directlyMentionsBot: true,
};

const originalSource = { guild_id: source.guildId, channel_id: source.channelId, id: source.messageId,
  author: { id: source.authorId, bot: false }, type: 0, content: `  exact <@${botId}>\n\tcontent  `,
  timestamp: '2026-10-20T00:00:00.000Z', edited_timestamp: null, mentions: [], attachments: [] };
const originalContext = { botUserId: botId, hasMessageContent: true, observedAt: new Date('2026-10-20T00:00:01Z') };

test('calling Yuna by name needs no slash command or Discord ping and unrelated chat stays quiet', () => {
  for (const content of ['Yuna help me', 'hey YUNA, where should I post?', 'can you help, yuna?', 'Ｙｕｎａ']) {
    assert.equal(normalizeConversationMessage({ ...source, content, directlyMentionsBot: false }, botId)?.text, content);
  }
  for (const content of ['hello everyone', 'Yunaverse', 'my_yuna_bot', '`Yuna`', '```\nYuna help\n```', '> Yuna, help me']) {
    assert.equal(normalizeConversationMessage({ ...source, content, directlyMentionsBot: false }, botId), null);
  }
  assert.equal(normalizeConversationMessage({ ...source, content: 'thanks', directlyMentionsBot: false }, botId, 'Previous Yuna answer')?.text, 'thanks');
  assert.equal(normalizeConversationMessage({ ...source, content: 'Yuna help', directlyMentionsBot: false, authorIsBot: true }, botId), null);
});

test('original capture preserves exact text, empty accessible content and detached bounded metadata', () => {
  const attachment = { id: source.authorId, filename: 'original name.png', content_type: 'image/png', size: 42,
    description: 'exact description', url: `https://example.invalid/${source.authorId}?secret=do-not-retain` };
  const input = { ...originalSource, attachments: [attachment] };
  const result = normalizeOriginalMessage(input, { ...originalContext, shardId: 1, gatewaySequence: 10 });
  assert.ok(result);
  assert.equal(result.capture.originalContent, originalSource.content);
  assert.deepEqual(result.capture.attachments, [{ id: source.authorId, filename: attachment.filename,
    contentType: 'image/png', byteSize: 42, description: 'exact description' }]);
  assert.equal(result.capture.attachmentsComplete, true);
  assert.deepEqual(result.capture.missingReasons, []);
  assert.equal(result.provenance.gatewaySequence, 10);
  assert.equal(result.provenance.shardId, 1);
  assert.equal(result.provenance.authorUserId, source.authorId);
  assert.equal(result.provenance.authorKind, 'user');
  assert.ok(Object.isFrozen(result.capture) && Object.isFrozen(result.capture.attachments[0]));
  attachment.filename = 'later edit';
  input.content = 'later edit';
  assert.equal(result.capture.originalContent, originalSource.content);
  assert.equal(result.capture.attachments[0]?.filename, 'original name.png');
  assert.ok(!JSON.stringify(result).includes('do-not-retain'));
  const empty = normalizeOriginalMessage({ ...originalSource, content: '' }, originalContext);
  assert.equal(empty?.capture.originalContent, '');
  assert.equal(empty?.capture.contentAccess, 'available');
});

test('restricted, missing and already edited creates never supply a fabricated original body', () => {
  const restricted = normalizeOriginalMessage({ ...originalSource, content: '' }, { ...originalContext, hasMessageContent: false });
  assert.equal(restricted?.capture.originalContent, null);
  assert.equal(restricted?.capture.contentAccess, 'restricted');
  assert.equal(restricted?.capture.attachmentsComplete, false);
  for (const overrides of [{ content: undefined }, { content: 'x'.repeat(100_001) }, { edited_timestamp: '2026-10-20T00:00:01Z' }]) {
    const missing = normalizeOriginalMessage({ ...originalSource, ...overrides }, originalContext);
    assert.equal(missing?.capture.originalContent, null);
    assert.equal(missing?.capture.contentAccess, 'missing');
    assert.ok(missing?.capture.missingReasons.length);
  }
  for (const overrides of [{ author: { id: botId, bot: true } }, { mentions: [{ id: botId }] }]) {
    const exempt = normalizeOriginalMessage({ ...originalSource, ...overrides }, { ...originalContext, hasMessageContent: false });
    assert.equal(exempt?.capture.contentAccess, 'available');
    assert.equal(exempt?.capture.originalContent, originalSource.content);
  }
});

test('original provenance identifies bots, webhooks, system and unknown authors without invented human targets', () => {
  for (const sample of [
    { overrides: { author: { id: source.authorId, bot: true } }, kind: 'bot', authorId: source.authorId },
    { overrides: { webhook_id: botId }, kind: 'webhook', authorId: null },
    { overrides: { type: 6 }, kind: 'system', authorId: null },
    { overrides: { author: null }, kind: 'unknown', authorId: null },
    { overrides: { webhook_id: 'invalid' }, kind: 'unknown', authorId: null },
  ]) {
    const captured = normalizeOriginalMessage({ ...originalSource, ...sample.overrides }, originalContext);
    assert.equal(captured?.provenance.authorKind, sample.kind);
    assert.equal(captured?.provenance.authorUserId, sample.authorId);
  }
  assert.equal(normalizeOriginalMessage({ ...originalSource, guild_id: 'invalid' }, originalContext), null);
  assert.equal(normalizeOriginalMessage({ ...originalSource, type: undefined }, originalContext), null);
  const unknownDate = normalizeOriginalMessage({ ...originalSource, timestamp: 'invalid' }, originalContext);
  assert.equal(unknownDate?.provenance.createdAt, null);
  assert.ok(unknownDate?.capture.missingReasons.includes('source_timestamp_missing'));
});

test('missing, duplicate and malformed attachments record incomplete coverage instead of inventing an empty set', () => {
  const attachment = { id: botId, filename: 'document', size: 0 };
  for (const attachments of [undefined, [attachment, attachment], [{ ...attachment, size: -1 }], Array(101).fill(attachment)]) {
    const result = normalizeOriginalMessage({ ...originalSource, attachments }, originalContext);
    assert.equal(result?.capture.attachmentsComplete, false);
    assert.ok(result?.capture.missingReasons.includes('attachment_metadata_incomplete'));
    assert.ok(result && result.capture.attachments.length <= 100);
  }
});

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

const commandSource: AdministrationCommandSnapshot = {
  actorId: source.authorId, guildId: source.guildId, channelId: source.channelId, sourceRequestId: source.messageId,
  actorIsBot: false, commandName: 'yuna', options: [{ name: 'status', type: 1 }],
};

test('staff sanctions retain exact targets, default deletion to zero and reject forged options or invalid history windows', () => {
  const options = [{ name: 'target', type: 3, value: botId }, { name: 'reason', type: 3, value: 'An explicit staff reason' }];
  /** Build the normalized Discord option tree used to test command validation. */
  const command = (name: string, entries: NonNullable<AdministrationCommandSnapshot['options'][number]['options']> = options) => normalizeAdministrationCommand({ ...commandSource, options: [{ name, type: 1, options: entries }] });
  assert.deepEqual(command('ban')?.arguments, { targetUserId: botId, reason: 'An explicit staff reason', deleteMessageSeconds: 0 });
  assert.deepEqual(command('kick')?.arguments, { targetUserId: botId, reason: 'An explicit staff reason' });
  assert.equal(command('kick', [...options, { name: 'delete-seconds', type: 4, value: 1 }]), null);
  assert.deepEqual(command('unban')?.arguments, { targetUserId: botId, reason: 'An explicit staff reason' });
  assert.equal(command('unban', [...options, { name: 'delete-seconds', type: 4, value: 1 }]), null);
  assert.equal(command('ban', [...options, { name: 'actorId', type: 3, value: botId }]), null);
  for (const value of [-1, 1.2, 604801]) assert.equal(command('ban', [...options, { name: 'delete-seconds', type: 4, value }]), null);
  assert.equal(command('ban', [options[0]!, { name: 'reason', type: 3, value: '\nsecret' }]), null);
  assert.equal(command('ban', [options[0]!, { name: 'reason', type: 3, value: 'x'.repeat(351) }]), null);
  const report = command('report', [{ name: 'channel', type: 7, value: source.channelId },
    { name: 'message-id', type: 3, value: source.messageId }, { name: 'allegation', type: 3, value: 'Reported allegation' }]);
  assert.deepEqual(report?.arguments, { channelId: source.channelId, messageId: source.messageId, allegation: 'Reported allegation' });
});

test('personal usage commands cannot select another actor and validate exact decimal currency limits', () => {
  /** Build the normalized Discord option tree used to test command validation. */
  const command = (name: string, options: NonNullable<AdministrationCommandSnapshot['options'][number]['options']> = []) =>
    normalizeAdministrationCommand({ ...commandSource, options: [{ name, type: 1, options }] });
  assert.deepEqual(command('usage')?.arguments, {}); assert.deepEqual(command('limit-clear')?.arguments, {});
  assert.equal(command('usage', [{ name: 'user', type: 6, value: botId }]), null);
  assert.deepEqual(command('limit', [{ name: 'attempts', type: 4, value: 0 }, { name: 'amount', type: 3, value: '1.123456789012345678' },
    { name: 'currency', type: 3, value: 'USD' }])?.arguments, { dailyAttemptLimit: 0, dailyBudget: { amount: '1.123456789012345678', currency: 'USD' } });
  assert.equal(command('limit'), null); assert.equal(command('limit', [{ name: 'amount', type: 3, value: '1' }]), null);
  for (const amount of ['-1', '1e3', '01', '1.1234567890123456789']) assert.equal(command('limit', [
    { name: 'amount', type: 3, value: amount }, { name: 'currency', type: 3, value: 'USD' }]), null);
  assert.equal(command('limit', [{ name: 'attempts', type: 4, value: 1000001 }]), null);
  assert.equal(command('limit', [{ name: 'amount', type: 3, value: '1' }, { name: 'currency', type: 3, value: 'usd' }]), null);
  assert.deepEqual(command('action', [{ name: 'action-id', type: 3, value: '01234567-89ab-4cde-8abc-0123456789ab' }])?.arguments,
    { actionId: '01234567-89ab-4cde-8abc-0123456789ab' });
});

test('operator commands normalize exact DTO arguments and derive replay identity from authenticated ingress', () => {
  const grant = normalizeAdministrationCommand({ ...commandSource, options: [{ name: 'grant', type: 1, options: [
    { name: 'user', type: 6, value: source.authorId }, { name: 'capability', type: 3, value: 'guild.pause' },
    { name: 'channel', type: 7, value: source.channelId }, { name: 'target', type: 6, value: botId },
    { name: 'expires', type: 3, value: '2027-01-01T00:00:00Z' },
  ] }] });
  assert.ok(grant?.command === 'grant');
  assert.deepEqual(grant.arguments, { granteeUserId: source.authorId, capability: 'guild.pause',
    scope: { channelIds: [source.channelId], targetUserIds: [botId] }, sourceOperationKey: `discord:${source.messageId}`,
    expiresAt: '2027-01-01T00:00:00.000Z' });
  assert.ok(Object.isFrozen(grant) && Object.isFrozen(grant.arguments) && Object.isFrozen(grant.arguments.scope.channelIds));
  for (const name of ['status', 'bootstrap', 'configure']) {
    assert.deepEqual(normalizeAdministrationCommand({ ...commandSource, options: [{ name, type: 1 }] })?.arguments, {});
  }
  const samples = [
    { name: 'pause', options: [{ name: 'safety-revision', type: 4, value: 2 }, { name: 'reason', type: 3, value: 'operator:pause' }], expected: { expectedSafetyRevision: 2, reasonCode: 'operator:pause' } },
    { name: 'resume', options: [{ name: 'safety-revision', type: 4, value: 3 }], expected: { expectedSafetyRevision: 3 } },
    { name: 'remove', options: [{ name: 'installation-revision', type: 4, value: 4 }], expected: { expectedInstallationRevision: 4 } },
    { name: 'channel', options: [{ name: 'channel', type: 7, value: source.channelId }, { name: 'mode', type: 3, value: 'silent' }, { name: 'row-revision', type: 4, value: 0 }], expected: { channelId: source.channelId, mode: 'silent', expectedRowRevision: 0 } },
    { name: 'revoke', options: [{ name: 'grant-id', type: 3, value: '01234567-89ab-4cde-8abc-0123456789ab' }, { name: 'authority-revision', type: 4, value: 0 }, { name: 'row-revision', type: 4, value: 1 }, { name: 'reason', type: 3, value: 'revoked' }], expected: { grantId: '01234567-89ab-4cde-8abc-0123456789ab', expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'revoked' } },
  ];
  for (const sample of samples) assert.deepEqual(normalizeAdministrationCommand({ ...commandSource, options: [{ name: sample.name, type: 1, options: sample.options }] })?.arguments, sample.expected);
});

test('command normalization rejects forged identity arguments, unknown options, duplicates and invalid revisions', () => {
  const rejected: AdministrationCommandSnapshot[] = [
    { ...commandSource, actorIsBot: true }, { ...commandSource, guildId: 'invalid' },
    { ...commandSource, commandName: 'other' }, { ...commandSource, options: [] },
    { ...commandSource, options: [{ name: 'status', type: 1 }, { name: 'bootstrap', type: 1 }] },
    { ...commandSource, options: [{ name: 'status', type: 2 }] },
    { ...commandSource, options: [{ name: 'unknown', type: 1 }] },
    { ...commandSource, options: [{ name: 'configure', type: 1, options: [{ name: 'path', type: 3, value: '/tmp/evil' }] }] },
    ...['actorId', 'guildId', 'installationId', 'sourceRequestId', 'permissions'].map(name => ({ ...commandSource, options: [{ name: 'status', type: 1, options: [{ name, type: 3, value: botId }] }] })),
    ...[-1, 0.5, Number.NaN, 2_147_483_648, '1'].map(value => ({ ...commandSource, options: [{ name: 'resume', type: 1, options: [{ name: 'safety-revision', type: 4, value }] }] })),
    { ...commandSource, options: [{ name: 'resume', type: 1, options: [{ name: 'safety-revision', type: 3, value: '1' }] }] },
    { ...commandSource, options: [{ name: 'resume', type: 1, options: [{ name: 'safety-revision', type: 4, value: 1 }, { name: 'safety-revision', type: 4, value: 2 }] }] },
    { ...commandSource, options: [{ name: 'resume', type: 1, options: [{ name: 'safety-revision', type: 4, value: 1, options: [] }] }] },
    { ...commandSource, options: [{ name: 'grant', type: 1, options: [{ name: 'user', type: 6, value: botId }, { name: 'capability', type: 3, value: 'administration.manage' }] }] },
    { ...commandSource, options: [{ name: 'grant', type: 1, options: [{ name: 'user', type: 6, value: botId }, { name: 'capability', type: 3, value: 'guild.pause' }, { name: 'expires', type: 3, value: '2027-02-30T00:00:00Z' }] }] },
    { ...commandSource, options: [{ name: 'pause', type: 1, options: [{ name: 'safety-revision', type: 4, value: 1 }, { name: 'reason', type: 3, value: 'bad\nreason' }] }] },
    { ...commandSource, options: [{ name: 'channel', type: 1, options: [{ name: 'channel', type: 7, value: source.channelId }, { name: 'mode', type: 3, value: 'proactive' }, { name: 'row-revision', type: 4, value: 0 }] }] },
  ];
  for (const input of rejected) assert.equal(normalizeAdministrationCommand(input), null, JSON.stringify(input));
});

test('channel status defaults to the authenticated source channel and accepts only an explicit channel option', () => {
  /** Build a read-only channel command while retaining authenticated transport identity. */
  const command = (options: NonNullable<AdministrationCommandSnapshot['options'][number]['options']> = []) =>
    normalizeAdministrationCommand({ ...commandSource, options: [{ name: 'channel-status', type: 1, options }] });
  assert.deepEqual(command()?.arguments, { channelId: source.channelId });
  const selected = command([{ name: 'channel', type: 7, value: '999' }]);
  assert.deepEqual(selected?.arguments, { channelId: '999' });
  assert.equal(selected?.actorId, commandSource.actorId);
  assert.ok(Object.isFrozen(selected?.arguments));
  assert.equal(command([{ name: 'channel', type: 3, value: '999' }]), null);
  assert.equal(command([{ name: 'channel', type: 7, value: 'invalid' }]), null);
  assert.equal(command([{ name: 'actorId', type: 3, value: '999' }]), null);
});

test('automatic setup is a parameter-free authenticated command', () => {
  const source = { actorId: '1', actorIsBot: false, guildId: '2', channelId: '3', sourceRequestId: '4', commandName: 'yuna' };
  assert.equal(normalizeAdministrationCommand({ ...source, options: [{ name: 'setup', type: 1 }] })?.command, 'setup');
  assert.equal(normalizeAdministrationCommand({ ...source, options: [{ name: 'setup', type: 1, options: [{ name: 'target', type: 3, value: '5' }] }] }), null);
});
