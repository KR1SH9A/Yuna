/** Check authenticated Debate command normalization and complete private consent reviews without live services. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from '@jest/globals';
import { normalizeAdministrationCommand, type AdministrationCommandSnapshot } from '../../src/discord/input-normalizer.js';
import { debateCommandDefinition } from '../../src/discord/debate-commands.js';
import { handleDebateCommand, type DebateCommands } from '../../apps/bot/debate.handlers.js';
import type { DebateSessionResponseDto } from '../../src/contexts/debates/dto/debate-session.dto.js';
import { parseDebateRubric } from '../../src/contexts/debates/dto/debate-session.dto.js';

const identity = { actorId: '1', guildId: '2', channelId: '3', sourceRequestId: '4' };
const sessionId = randomUUID(), scopeHash = 'a'.repeat(64);
/** Mirror authenticated Discord ingress while retaining deliberately untrusted nested option values. */
function snapshot(operation: string, options: { name: string; type: number; value: unknown }[]): AdministrationCommandSnapshot {
  return { ...identity, actorIsBot: false, commandName: 'yuna', options: [{ name: 'debate', type: 2, options: [{ name: operation, type: 1, options }] }] };
}
/** Build a full review larger than one Discord message so truncation would be observable. */
function state(): DebateSessionResponseDto {
  return { sessionId, state: 'proposed', revision: 1, scopeHash, channelId: '3', participantIds: ['1', '5'], topic: 'Exact topic',
    rubric: { criteria: [{ id: 'reasoning', description: 'Full criterion '.repeat(30), levels: ['Low '.repeat(30), 'High '.repeat(30)], weight: '1' }],
      minimumWinningMargin: '0.1', minimumConfidence: 0.8, paired: true, maximumPairDifference: 1 },
    consentedUserIds: [], assessmentModel: 'selected-model', transcriptId: null, evaluationId: null,
    purgeAfter: '2027-01-01T00:00:00.000Z', processing: 'explicit_submissions_jev_scoring', retentionSeconds: 3600, payerUserId: '1' };
}

test('all Debate operations require their exact options and authenticated identity', () => {
  const session = { name: 'session', type: 3, value: sessionId };
  for (const name of ['start', 'freeze', 'status', 'result', 'cancel']) {
    assert.equal(normalizeAdministrationCommand(snapshot(name, [session]))?.command, 'debate');
    assert.equal(normalizeAdministrationCommand(snapshot(name, [session, { name: 'actorId', type: 3, value: '5' }])), null);
  }
  const consent = normalizeAdministrationCommand(snapshot('consent', [session, { name: 'scope-hash', type: 3, value: scopeHash }, { name: 'accept', type: 5, value: false }]));
  assert.deepEqual(consent?.arguments, { operation: 'consent', sessionId, scopeHash, accept: false });
  assert.equal(normalizeAdministrationCommand(snapshot('submit', [session, { name: 'text', type: 3, value: ' '.repeat(10) }])), null);
  assert.equal(normalizeAdministrationCommand({ ...snapshot('status', [session]), actorIsBot: true }), null);
  assert.equal(debateCommandDefinition.options!.length, 8);
});

test('proposal keeps exact rubric JSON and rejects malformed options without choosing a model', () => {
  const input = [{ name: 'opponent', type: 6, value: '5' }, { name: 'topic', type: 3, value: 'Topic' },
    { name: 'rubric', type: 3, value: JSON.stringify(state().rubric) }, { name: 'retention-seconds', type: 4, value: 3600 }];
  const command = normalizeAdministrationCommand(snapshot('propose', input));
  assert.equal(command?.command, 'debate'); assert.equal(command?.actorId, identity.actorId);
  assert.deepEqual(command?.arguments, { operation: 'propose', opponentUserId: '5', topic: 'Topic', rubric: state().rubric, retentionSeconds: 3600 });
  assert.equal(normalizeAdministrationCommand(snapshot('propose', input.map(option => option.name === 'rubric' ? { ...option, value: '{broken' } : option))), null);
  assert.equal(normalizeAdministrationCommand(snapshot('propose', [...input, { name: 'model', type: 3, value: 'injected' }])), null);
});

test('the editable two-criterion starter passes owner validation and the Discord command bound', async () => {
  const text = await readFile('config/debate-rubric.example.json', 'utf8');
  assert(text.length <= 4000); assert.equal(parseDebateRubric(JSON.parse(text)).criteria.length, 2);
  const command = normalizeAdministrationCommand(snapshot('propose', [{ name: 'opponent', type: 6, value: '5' },
    { name: 'topic', type: 3, value: 'A topic both participants choose' }, { name: 'rubric', type: 3, value: text },
    { name: 'retention-seconds', type: 4, value: 3600 }]));
  assert.equal(command?.command, 'debate');
});

test('private proposal review attaches every scope field and binds the destination to authenticated ingress', async () => {
  const proposed = state(), calls: unknown[] = [];
  const debates = { /** Capture the caller and complete proposal selected by the handler. */
    async proposeSession(caller: unknown, input: unknown) { calls.push([caller, input]); return proposed; } } as unknown as DebateCommands;
  const command = { ...identity, command: 'debate' as const, arguments: { operation: 'propose' as const, opponentUserId: '5', topic: 'Exact topic', rubric: proposed.rubric, retentionSeconds: 3600 } };
  const result = await handleDebateCommand(command, { scope: { installationId: 'trusted-installation', guildId: '2' }, debates });
  assert.equal(typeof result, 'object'); if (typeof result === 'string') return;
  const review = JSON.parse(result.attachment.content) as DebateSessionResponseDto;
  assert.deepEqual(review.rubric, proposed.rubric); assert.equal(review.scopeHash, scopeHash); assert.equal(review.assessmentModel, proposed.assessmentModel);
  assert.equal(review.payerUserId, '1'); assert.equal(review.retentionSeconds, 3600); assert(result.content.length <= 2000);
  assert.deepEqual((calls[0] as unknown[])[0], { installationId: 'trusted-installation', guildId: '2', actorId: '1', sourceRequestId: '4' });
  assert.equal(((calls[0] as unknown[])[1] as { channelId: string }).channelId, '3');
});

test('missing assessment configuration blocks new processing but still permits withdrawal', async () => {
  const calls: unknown[] = [];
  const debates = { /** Capture only an explicit participant consent withdrawal. */
    async recordConsent(caller: unknown, input: unknown) { calls.push([caller, input]); return state(); } } as unknown as DebateCommands;
  const services = { scope: { installationId: 'trusted-installation', guildId: '2' }, debates, canEvaluate: false };
  const accepted = { ...identity, command: 'debate' as const, arguments: { operation: 'consent' as const, sessionId, scopeHash, accept: true } };
  assert.match(await handleDebateCommand(accepted, services) as string, /unavailable/); assert.equal(calls.length, 0);
  assert.equal(typeof await handleDebateCommand({ ...accepted, arguments: { ...accepted.arguments, accept: false } }, services), 'object');
  assert.equal(calls.length, 1);
});
