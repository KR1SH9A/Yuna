/** Structured planning interprets natural admin tasks without giving the provider Discord authority. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { parseAdminResponse, type AdminAssistantContext } from '../../src/ai/contracts/admin-assistant.contracts.js';
import { LlmService } from '../../src/ai/llm/llm.service.js';
import { prepareReplyGenerationInput } from '../../src/ai/contracts/generation.contracts.js';

const context: AdminAssistantContext = { actorId: '1', guildId: '2', channelId: '3', sourceMessageId: '9', directoryPartial: false,
  channels: [{ id: '3', name: 'admin-chat', type: 0, parentId: null }, { id: '4', name: 'vc created by yuna', type: 2, parentId: null },
    { id: '5', name: 'Voice Channels', type: 4, parentId: null }], recentActions: [{ kind: 'create', channelId: '4', state: 'CONFIRMED' }] };
const request = 'yuna can you put "vc created by yuna" in the appropriate voice channels category';
const proposal = { type: 'action', intentQuote: request, intent: { kind: 'move', channelId: '4', parentId: '5' } };

test('plans accept supplied channel/category IDs and reject invented targets, extra permissions and foreign intent', () => {
  assert.deepEqual(parseAdminResponse(JSON.stringify(proposal), context, request), proposal);
  for (const bad of [ { ...proposal, intentQuote: 'delete everything' }, { ...proposal, intent: { ...proposal.intent, channelId: '999' } },
    { ...proposal, intent: { ...proposal.intent, parentId: '3' } }, { ...proposal, intent: { ...proposal.intent, channelId: '5' } },
    { ...proposal, intent: { ...proposal.intent, permission_overwrites: [] } }, { ...proposal, intent: { kind: 'delete', channelId: '4' } } ]) {
    assert.equal(parseAdminResponse(JSON.stringify(bad), context, request), null);
  }
  assert.equal(parseAdminResponse('{"type":"action"', context, request), null);
  assert.deepEqual(parseAdminResponse('{"type":"clarify","text":"Which voice channel?"}', context, request), { type: 'clarify', text: 'Which voice channel?' });
  assert.throws(() => prepareReplyGenerationInput({ text: 'x'.repeat(4000), previousReply: 'x'.repeat(2000), adminContext: context, maxOutputTokens: 100 }), /Combined/);
});

test('natural request uses JSON planning with directory and completed actions; invalid or truncated plans become clarification', async () => {
  let output = JSON.stringify(proposal), truncated = false;
  const llm = new LlmService({ mode: 'live', endpoint: 'https://api.deepseek.com/chat/completions', apiKey: 'fixture', model: 'model' }, 1000,
    async (_url, options) => {
      const body = JSON.parse(options!.body as string);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.match(body.messages[0].content, /Only the CURRENT administrator request/);
      assert.match(body.messages[1].content, /Voice Channels/); assert.match(body.messages[1].content, /CONFIRMED/);
      assert.equal(body.messages.at(-1).content, request);
      return new Response(JSON.stringify({ id: 'result', model: 'model', object: 'chat.completion',
        choices: [{ index: 0, finish_reason: truncated ? 'length' : 'stop', message: { role: 'assistant', content: output } }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } }));
    });
  const input = { text: request, adminContext: context, maxOutputTokens: 128 };
  assert.deepEqual(JSON.parse((await llm.generateReply(input)).text), proposal);
  output = '{bad'; assert.equal(JSON.parse((await llm.generateReply(input)).text).type, 'clarify');
  output = JSON.stringify(proposal); truncated = true;
  assert.equal(JSON.parse((await llm.generateReply(input)).text).type, 'clarify');
});
