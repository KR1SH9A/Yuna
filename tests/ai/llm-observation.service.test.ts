/** Observation accepts only grounded spans and shares the LLM adapter's bounded, single-attempt HTTP lifecycle. */
import { expect, test, jest } from '@jest/globals';
import { LlmService, LlmError } from '../../src/ai/llm/llm.service.js';
import type { ObservationInput } from '../../src/ai/contracts/observation.contracts.js';
const id = '11111111-1111-4111-8111-111111111111';
const input: ObservationInput = { schemaVersion: 1, evidenceRevisionId: id, content: 'Keep this exact quotation.',
  sourceReferences: [`evidence:${id}`], maxOutputTokens: 1024 };
const config = { mode: 'live' as const, endpoint: 'https://api.deepseek.com/chat/completions', apiKey: 'fixture-secret', model: 'chosen-model' };
/** Return provider-shaped metadata while varying only the JSON capability output. */
function response(value: unknown, finishReason = 'stop') {
  return new Response(JSON.stringify({ id: 'request-1', object: 'chat.completion', model: 'served-model',
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: JSON.stringify(value) } }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
}
const observed = { quotes: [{ quote: 'exact quotation', start: 10, end: 25 }], inspectedBody: true, limitations: [] };

test('JSON mode preserves owner bindings and constructs statements only from matching source spans', async () => {
  const fetcher = jest.fn<typeof fetch>(async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1]).toEqual({ role: 'user', content: JSON.stringify({ content: input.content }) });
    expect(body.max_tokens).toBe(1024);
    return response(observed);
  });
  const result = await new LlmService(config, 1000, fetcher).observeContent(input);
  expect(result).toMatchObject({ outcome: 'observed', evidenceRevisionId: id, sourceReferences: input.sourceReferences,
    requestedModel: 'chosen-model', model: 'served-model', inputTokens: 20, outputTokens: 10, totalTokens: 30,
    facts: [{ ...observed.quotes[0], statement: 'exact quotation' }] });
  expect(Object.isFrozen(result.facts) && Object.isFrozen(result.sourceReferences)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
  { ...observed, quotes: [{ quote: 'invented quotation', start: 10, end: 25 }] },
  { ...observed, quotes: [{ quote: 'exact quotation', start: 11, end: 25 }] },
  { ...observed, quotes: [{ ...observed.quotes[0], statement: 'established violation' }] },
  { ...observed, quotes: [observed.quotes[0], observed.quotes[0]] },
  { ...observed, inspectedBody: false },
  { ...observed, limitations: ['secret raw explanation'] },
  { ...observed, action: 'ban' },
])('malformed or unsupported observations remain uncertain spend (%#)', async value => {
  const fetcher = jest.fn<typeof fetch>(async () => response(value));
  await expect(new LlmService(config, 1000, fetcher).observeContent(input)).rejects.toMatchObject({ code: 'invalid_response', costMayHaveBeenIncurred: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('fake provider has no findings; cancellation and oversized text never dispatch', async () => {
  const fetcher = jest.fn<typeof fetch>();
  const service = new LlmService({ mode: 'fake' }, 1000, fetcher);
  await expect(service.observeContent(input)).resolves.toMatchObject({ outcome: 'uncertain', uncertaintyReason: 'fake_provider', inspectedBody: false, facts: [] });
  await expect(service.observeContent({ ...input, sourceReferences: ['model-selected'] })).rejects.toMatchObject({ code: 'invalid_input', costMayHaveBeenIncurred: false });
  await expect(service.observeContent({ ...input, content: 'x'.repeat(16001) })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(service.observeContent({ ...input, content: '界'.repeat(16000) })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(service.observeContent(input, AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled', costMayHaveBeenIncurred: false });
  expect(fetcher).not.toHaveBeenCalled();
});

test('truncation cannot turn partial JSON into accepted evidence', async () => {
  await expect(new LlmService(config, 1000, async () => response(observed, 'length')).observeContent(input)).rejects.toBeInstanceOf(LlmError);
});

test('observation body timeout uses the shared deadline and does not retry', async () => {
  const fetcher = jest.fn<typeof fetch>(async () => new Response(new ReadableStream({ /** Start the controlled response stream with this test's chosen chunks or stall. */ start() {} })));
  await expect(new LlmService(config, 10, fetcher).observeContent(input)).rejects.toMatchObject({ code: 'timeout', costMayHaveBeenIncurred: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
