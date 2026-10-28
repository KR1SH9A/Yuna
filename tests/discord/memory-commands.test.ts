/** Verify private memory parsing and safe responses without a database, Discord connection or provider. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { memoryCommandDefinition, normalizeMemoryCommand } from '../../src/discord/memory-commands.js';
import { handleMemoryCommand } from '../../apps/bot/memory.handlers.js';
import type { MemoryService } from '../../src/contexts/memory/memory.service.js';
import { normalizeAdministrationCommand } from '../../src/discord/input-normalizer.js';
import { administrationCommandDefinition } from '../../src/discord/discord.module.js';

const identity = { actorId: '1', guildId: '2', channelId: '3', sourceRequestId: '4' }, factId = '01234567-89ab-4cde-8abc-0123456789ab';
/** Build only a serialized slash-command snapshot, including its nested subcommand group. */
function group(name: string, options: { name: string; type: number; value: unknown }[] = []) {
  return { name: 'memory', type: 2, options: [{ name, type: 1, options }] };
}

test('memory registration and parsing preserve explicit self-only intent and bounded retention', () => {
  assert.equal(memoryCommandDefinition.type, 2); assert.equal(memoryCommandDefinition.options?.length, 4);
  const consent = normalizeMemoryCommand(identity, group('consent', [{ name: 'granted', type: 5, value: true }, { name: 'revision', type: 4, value: 0 }]));
  assert.deepEqual(consent?.arguments, { operation: 'consent', granted: true, expectedPrivacyRevision: 0, retentionDays: 30 });
  assert.ok(Object.isFrozen(consent?.arguments));
  assert.deepEqual(normalizeMemoryCommand(identity, group('remember', [{ name: 'text', type: 3, value: '  Exact text  ' },
    { name: 'revision', type: 4, value: 1 }]))?.arguments, { operation: 'remember', text: '  Exact text  ', expectedPrivacyRevision: 1 });
  assert.deepEqual(normalizeMemoryCommand(identity, group('inspect'))?.arguments, { operation: 'inspect', offset: 0 });
  assert.deepEqual(normalizeMemoryCommand(identity, group('forget', [{ name: 'revision', type: 4, value: 2 },
    { name: 'fact-id', type: 3, value: factId }]))?.arguments, { operation: 'forget', expectedPrivacyRevision: 2, factId });
  assert.ok(administrationCommandDefinition.options?.some(option => option.name === 'memory'));
  assert.equal(normalizeAdministrationCommand({ ...identity, actorIsBot: false, commandName: 'yuna', options: [group('inspect')] })?.command, 'memory');
});

test('memory parser rejects forged subjects, invalid groups, duplicate options and unbounded values', () => {
  const samples = [null, group('unknown'), { ...group('inspect'), type: 1 },
    group('inspect', [{ name: 'user', type: 6, value: '9' }]),
    group('inspect', [{ name: 'offset', type: 4, value: 51 }]),
    group('remember', [{ name: 'text', type: 3, value: 'x'.repeat(501) }, { name: 'revision', type: 4, value: 1 }]),
    group('remember', [{ name: 'text', type: 3, value: '   ' }, { name: 'revision', type: 4, value: 1 }]),
    group('forget', [{ name: 'fact-id', type: 3, value: 'wrong' }, { name: 'revision', type: 4, value: 1 }]),
    group('consent', [{ name: 'granted', type: 5, value: 'true' }, { name: 'revision', type: 4, value: 1 }]),
    group('consent', [{ name: 'granted', type: 5, value: true }, { name: 'revision', type: 4, value: 1 }, { name: 'days', type: 4, value: 31 }]),
    group('inspect', [{ name: 'offset', type: 4, value: 1 }, { name: 'offset', type: 4, value: 2 }]),
  ];
  for (const value of samples) assert.equal(normalizeMemoryCommand(identity, value), null);
  assert.equal(normalizeMemoryCommand({ ...identity, actorId: 'invalid' }, group('inspect')), null);
});

test('private handlers bind the running installation, strip operation selectors and redact storage errors', async () => {
  const calls: unknown[] = [];
  const memory: Pick<MemoryService, 'setConsent' | 'remember' | 'inspectOwnFacts' | 'forget'> = {
    /** Capture the authenticated member consent change for handler assertions. */
    async setConsent(caller, input) { calls.push([caller, input]); return { granted: true, retentionDays: 30, privacyRevision: 1, erasedFacts: 0 }; },
    /** Capture the explicit private fact submission without storing data outside the fixture. */
    async remember(caller, input) { calls.push([caller, input]); return { factId, privacyRevision: 1, expiresAt: 'tomorrow', duplicate: false }; },
    /** Return only the caller-owned memory fixture for private response assertions. */
    async inspectOwnFacts(caller, input) { calls.push([caller, input]); return { granted: true, retentionDays: 30, privacyRevision: 1, erasedFacts: 0,
      facts: [{ factId, text: 'Private requested fact', acceptedAt: 'today', expiresAt: 'tomorrow' }], nextOffset: null }; },
    /** Capture the exact private memory deletion request for handler assertions. */
    async forget(caller, input) { calls.push([caller, input]); return { deletionId: factId, privacyRevision: 2, erasedFacts: 1, state: 'complete' }; },
  };
  const services = { scope: { installationId: factId, guildId: '2' }, memory };
  const inspect = normalizeMemoryCommand(identity, group('inspect'))!;
  assert.match(await handleMemoryCommand(inspect, services), /Private requested fact/);
  assert.deepEqual(calls[0], [{ installationId: factId, guildId: '2', actorId: '1', sourceRequestId: '4' }, { offset: 0 }]);
  const save = normalizeMemoryCommand(identity, group('remember', [{ name: 'text', type: 3, value: 'Private' }, { name: 'revision', type: 4, value: 1 }]))!;
  assert.match(await handleMemoryCommand(save, services), /saved/);
  assert.deepEqual((calls[1] as unknown[])[1], { text: 'Private', expectedPrivacyRevision: 1 });
  assert.match(await handleMemoryCommand({ ...inspect, guildId: '9' }, services), /another installation/);
  memory.inspectOwnFacts = async () => { throw new Error('secret SQL and retained content'); };
  const response = await handleMemoryCommand(inspect, services); assert.match(response, /not applied/); assert.ok(!response.includes('secret'));
});
