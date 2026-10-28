/** Exercise exact vector bindings, bounded disclosure, cancellation and unknown-cost behavior without provider calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { inspect } from 'node:util';
import { test } from '@jest/globals';
import { EmbeddingError, EmbeddingService } from '../../src/ai/embeddings/embedding.service.js';
import { prepareEmbeddingInput, type EmbeddingInput } from '../../src/ai/contracts/embedding.contracts.js';

const config = { mode: 'live' as const, endpoint: 'https://openrouter.ai/api/v1/embeddings' as const,
  apiKey: 'fixture-secret', model: 'provider/embedding-model' };

/** Fresh owner-shaped inputs let mutation tests distinguish captured data from caller-owned objects. */
function input(): EmbeddingInput {
  return { schemaVersion: 1, model: config.model, dimensions: 3,
    texts: ['First private fact', 'Second private fact'].map((text, index) => ({ reference: 'fact:' + index,
      text, contentHash: createHash('sha256').update(text).digest('hex') })) };
}
/** Reverse indexes deliberately; response position cannot substitute for the provider's explicit input index. */
function response(): Record<string, unknown> {
  return { object: 'list', model: config.model, id: 'embedding-request',
    data: [{ object: 'embedding', index: 1, embedding: [0.4, 0.5, 0.6] }, { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
    usage: { prompt_tokens: 8, total_tokens: 8 } };
}
/** Error assertions check both safe classification and whether unobserved spend must stay reserved. */
function error(code: string, cost: boolean): (value: unknown) => boolean {
  return value => value instanceof EmbeddingError && value.code === code && value.costMayHaveBeenIncurred === cost;
}

test('one embedding request sends only authorized text and restores indexed results to owner order', async () => {
  let calls = 0;
  const source = input();
  const service = new EmbeddingService(config, 1000, async (url, options) => {
    calls++;
    assert.equal(url, config.endpoint); assert.equal(options?.redirect, 'error');
    assert.deepEqual(JSON.parse(options?.body as string), { model: config.model, input: source.texts.map(item => item.text),
      dimensions: 3, encoding_format: 'float' });
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-secret');
    return Response.json(response());
  });
  const result = await service.embedTexts(source);
  assert.equal(calls, 1); assert.equal(result.providerRequestId, 'embedding-request');
  assert.deepEqual(result.vectors.map(item => item.vector), [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
  assert.deepEqual(result.vectors.map(item => item.contentHash), source.texts.map(item => item.contentHash));
  assert.equal(result.inputTokens, 8); assert.ok(Object.isFrozen(result.vectors[0]!.vector));
  assert.ok(!JSON.stringify(result).includes('private fact'));
});

test('input and credentials are snapshotted before asynchronous provider completion', async () => {
  let release!: (value: Response) => void;
  const source = input(), selected = { ...config };
  const service = new EmbeddingService(selected, 1000, async (_url, options) => {
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-secret');
    return new Promise<Response>(resolve => { release = resolve; });
  });
  selected.apiKey = 'replaced-secret';
  const promise = service.embedTexts(source);
  const expected = source.texts[0]!.contentHash;
  (source.texts[0] as { text: string; contentHash: string }).text = 'Changed';
  (source.texts[0] as { contentHash: string }).contentHash = 'changed';
  release(Response.json(response()));
  assert.equal((await promise).vectors[0]!.contentHash, expected);
});

test('missing usage remains explicitly unknown and optional response identity stays null', async () => {
  const value = response(); delete value.usage; delete value.id;
  const result = await new EmbeddingService(config, 1000, async () => Response.json(value)).embedTexts(input());
  assert.equal(result.inputTokens, null); assert.equal(result.totalTokens, null); assert.equal(result.providerRequestId, null);
});

test('fake mode is explicit, deterministic and cannot dispatch or masquerade as a selected live model', async () => {
  let calls = 0;
  const service = new EmbeddingService({ mode: 'fake' }, 1000, async () => { calls++; throw new Error(); });
  const source = { ...input(), model: 'fake' };
  const result = await service.embedTexts(source);
  assert.deepEqual(result, await service.embedTexts(source)); assert.equal(result.provider, 'fake'); assert.equal(calls, 0);
  await assert.rejects(service.embedTexts(input()), error('invalid_input', false));
});

test('invalid bindings and bounds fail before disclosure', async () => {
  let calls = 0;
  const service = new EmbeddingService(config, 1000, async () => { calls++; return Response.json(response()); });
  const source = input();
  const bad: unknown[] = [null, { ...source, schemaVersion: 2 }, { ...source, model: 'other-model' },
    { ...source, dimensions: 0 }, { ...source, dimensions: 4097 }, { ...source, texts: [] },
    { ...source, texts: [source.texts[0], source.texts[0]] },
    { ...source, texts: [{ ...source.texts[0], contentHash: '0'.repeat(64) }] },
    { ...source, texts: [{ ...source.texts[0], text: 'x'.repeat(8193) }] },
    { ...source, texts: Array.from({ length: 17 }, (_, index) => ({ ...source.texts[0], reference: 'fact:' + index })) }];
  for (const value of bad) await assert.rejects(service.embedTexts(value as EmbeddingInput), error('invalid_input', false));
  const full = 'x'.repeat(8192);
  assert.throws(() => prepareEmbeddingInput({ ...source, texts: Array.from({ length: 9 }, (_, index) => ({ reference: 'fact:' + index,
    text: full, contentHash: createHash('sha256').update(full).digest('hex') })) }));
  assert.equal(calls, 0);
});

test.each(['duplicate', 'missing', 'dimension', 'nonfinite', 'string', 'model', 'usage', 'identity', 'index', 'object'])
('malformed %s response never becomes an accepted embedding', async kind => {
  const value = response();
  const data = value.data as { index: number; object: string; embedding: unknown[] }[];
  if (kind === 'duplicate') data[1]!.index = 1;
  if (kind === 'missing') data.pop();
  if (kind === 'dimension') data[0]!.embedding.pop();
  if (kind === 'nonfinite') data[0]!.embedding[0] = Infinity;
  if (kind === 'string') data[0]!.embedding[0] = '0.3';
  if (kind === 'model') value.model = 'different-model';
  if (kind === 'usage') value.usage = { prompt_tokens: 8, total_tokens: 9 };
  if (kind === 'identity') value.id = 'unsafe\nidentity';
  if (kind === 'index') data[0]!.index = 2;
  if (kind === 'object') data[0]!.object = 'completion';
  await assert.rejects(new EmbeddingService(config, 1000, async () => Response.json(value)).embedTexts(input()), error('invalid_response', true));
});

test.each([401, 402, 429, 500])('HTTP %s is a single safe failure with possible spend', async status => {
  let calls = 0;
  const service = new EmbeddingService(config, 1000, async () => { calls++; return new Response('fixture-secret private fact', { status }); });
  try { await service.embedTexts(input()); assert.fail('Expected failure'); }
  catch (failure) {
    assert.ok(failure instanceof EmbeddingError); assert.equal(failure.costMayHaveBeenIncurred, true);
    assert.ok(!inspect(failure).includes('fixture-secret')); assert.ok(!inspect(failure).includes('private fact'));
  }
  assert.equal(calls, 1);
});

test('pre-dispatch cancellation makes no call; in-flight cancellation remains potentially charged and removes listeners', async () => {
  let calls = 0;
  const service = new EmbeddingService(config, 1000, async () => { calls++; return new Promise<Response>(() => {}); });
  const before = new AbortController(); before.abort('private reason');
  await assert.rejects(service.embedTexts(input(), before.signal), error('cancelled', false)); assert.equal(calls, 0);
  const after = new AbortController();
  const pending = service.embedTexts(input(), after.signal); after.abort('private reason');
  await assert.rejects(pending, error('cancelled', true)); assert.equal(calls, 1);
  assert.equal(getEventListeners(after.signal, 'abort').length, 0);
});

test('deadline covers a transport that ignores cancellation and a stalled response body', async () => {
  await assert.rejects(new EmbeddingService(config, 20, async () => new Promise<Response>(() => {})).embedTexts(input()), error('timeout', true));
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    /** Observe whether timeout closes the stalled response stream. */
    cancel() { cancelled = true; },
  });
  await assert.rejects(new EmbeddingService(config, 20, async () => new Response(body)).embedTexts(input()), error('timeout', true));
  assert.equal(cancelled, true);
});

test('byte bounds and strict UTF-8 decoding reject oversized or malformed response streams', async () => {
  const bodies = [new Response('x', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }),
    new Response(new Uint8Array(2 * 1024 * 1024 + 1)), new Response(new Uint8Array([0xff]))];
  for (const body of bodies) await assert.rejects(new EmbeddingService(config, 1000, async () => body).embedTexts(input()), error('invalid_response', true));
});

test('arbitrary endpoints and secret-bearing network failures expose only safe errors', async () => {
  assert.throws(() => new EmbeddingService({ ...config, endpoint: 'https://other.invalid' } as unknown as typeof config, 1000), error('invalid_configuration', false));
  assert.throws(() => new EmbeddingService(config, 0), error('invalid_configuration', false));
  const service = new EmbeddingService(config, 1000, async () => { throw new Error('fixture-secret First private fact'); });
  await assert.rejects(service.embedTexts(input()), failure => {
    assert.ok(error('network', true)(failure)); assert.ok(!inspect(failure).includes('fixture-secret')); return true;
  });
});
