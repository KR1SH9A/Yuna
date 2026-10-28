/** Knowledge commands keep approval arguments separate from authenticated identity and require exact revisions. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from '@jest/globals';
import { normalizeAdministrationCommand, type AdministrationCommandSnapshot } from '../../src/discord/input-normalizer.js';
import { knowledgeCommandDefinition } from '../../src/discord/knowledge-commands.js';

/** Create the same minimal nested option shape provided by authenticated Discord ingress. */
function snapshot(name: string, options: { name: string; type: number; value: unknown }[]): AdministrationCommandSnapshot {
  return { actorId: '1', guildId: '2', channelId: '3', sourceRequestId: '4', actorIsBot: false, commandName: 'yuna',
    options: [{ name: 'knowledge', type: 2, options: [{ name, type: 1, options }] }] };
}

test('knowledge approval defaults to the current exact channel and derives request provenance', () => {
  const command = normalizeAdministrationCommand(snapshot('approve', [{ name: 'content', type: 3, value: 'Reviewed reference text' }]));
  assert.equal(command?.command, 'knowledge-approve');
  if (command?.command !== 'knowledge-approve') return;
  assert.deepEqual(command.arguments.visibility, { schemaVersion: 1, kind: 'channels', channelIds: ['3'] });
  assert.deepEqual(command.arguments.provenance, { kind: 'staff_submission', sourceReference: 'discord-command:4' });
  assert.equal(command.actorId, '1');
});

test('knowledge replacements require both predecessor and current revision, with no actor override', () => {
  const id = randomUUID(), base = [{ name: 'content', type: 3, value: 'Replacement' }, { name: 'replaces', type: 3, value: id }];
  assert.equal(normalizeAdministrationCommand(snapshot('approve', base)), null);
  assert.ok(normalizeAdministrationCommand(snapshot('approve', [...base, { name: 'revision', type: 4, value: 1 }])));
  assert.equal(normalizeAdministrationCommand(snapshot('approve', [{ name: 'content', type: 3, value: 'Text' }, { name: 'actorId', type: 3, value: '9' }])), null);
});

test('knowledge read, search and mutations retain their exact arguments and reject malformed groups', () => {
  const id = randomUUID();
  assert.equal(normalizeAdministrationCommand(snapshot('read', [{ name: 'entry', type: 3, value: id }]))?.command, 'knowledge-read');
  const search = normalizeAdministrationCommand(snapshot('search', [{ name: 'query', type: 3, value: 'support desk' }]));
  assert.deepEqual(search?.arguments, { search: 'support desk', channelId: '3' });
  assert.equal(normalizeAdministrationCommand(snapshot('visibility', [{ name: 'entry', type: 3, value: id }, { name: 'revision', type: 4, value: 1 }, { name: 'visibility', type: 3, value: 'guild' }]))?.command, 'knowledge-visibility');
  assert.equal(normalizeAdministrationCommand(snapshot('retire', [{ name: 'entry', type: 3, value: id }, { name: 'revision', type: 4, value: 0 }, { name: 'reason', type: 3, value: 'obsolete' }])), null);
  assert.equal(normalizeAdministrationCommand({ ...snapshot('read', []), actorIsBot: true }), null);
  assert.equal(knowledgeCommandDefinition.type, 2); assert.equal(knowledgeCommandDefinition.options!.length, 5);
});
