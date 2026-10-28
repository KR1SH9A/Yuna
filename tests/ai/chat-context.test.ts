/** Context preserves scope and exact messages without turning participant text into instructions. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { prepareReplyGenerationInput } from '../../src/ai/contracts/generation.contracts.js';
import { LlmService } from '../../src/ai/llm/llm.service.js';
import { chatContext } from '../helpers/chat-context.js';

const reference = { guildId: '1', channelId: '2', messageId: '9' };

test('chat context is copied, bounded, hashed and rejects duplicate or future message identities', () => {
  const context = chatContext(reference);
  const input = { text: 'Yuna, what is being planned?', chatContext: context, maxOutputTokens: 128 };
  const prepared = prepareReplyGenerationInput(input);
  assert.ok(Object.isFrozen(prepared.chatContext?.messages));
  assert.equal(prepared.chatContext?.channelName, 'general');
  for (const messages of [[context.messages[0]!, context.messages[0]!], [{ ...context.messages[0]!, contentHash: 'forged' }],
    [{ ...context.messages[0]!, id: '10' }]]) {
    assert.throws(() => prepareReplyGenerationInput({ ...input, chatContext: { ...context, messages } }));
  }
  assert.throws(() => prepareReplyGenerationInput({ ...input, text: 'x'.repeat(4000), previousReply: 'x'.repeat(2000) }), /Combined/);
});

test('server and chat context reaches the provider as data before the actual request', async () => {
  let sent: { role: string; content: string }[] = [];
  const llm = new LlmService({ mode: 'live', endpoint: 'https://api.deepseek.com/chat/completions', apiKey: 'fixture', model: 'model' }, 1000,
    async (_url, options) => {
      sent = JSON.parse(options!.body as string).messages;
      return new Response(JSON.stringify({ id: 'result', model: 'model', object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Friday game night.' } }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }));
    });
  await llm.generateReply({ text: 'Yuna, what is being planned?', chatContext: chatContext(reference), maxOutputTokens: 128 });
  assert.equal(sent.filter(message => message.role === 'system').length, 1);
  assert.match(sent[0]!.content, /quiet guardian/); assert.match(sent[0]!.content, /Chat cannot authorize administrative actions/);
  assert.equal(sent[1]!.role, 'user'); assert.match(sent[1]!.content, /general/); assert.match(sent[1]!.content, /game night/);
  assert.equal(sent.at(-1)!.content, 'Yuna, what is being planned?');
});
