/** Execute one bounded OpenRouter embedding request; never retrieve facts, retry charges or decide memory consent. */
import { createHash } from 'node:crypto';
import { invariant } from '../../platform/db/entity-values.js';
import { prepareEmbeddingInput, type EmbeddingInput, type EmbeddingProviderConfig, type EmbeddingResult } from '../contracts/embedding.contracts.js';

export type EmbeddingErrorCode = 'invalid_configuration' | 'invalid_input' | 'cancelled' | 'timeout'
  | 'authentication' | 'insufficient_balance' | 'invalid_request' | 'rate_limited'
  | 'provider_unavailable' | 'invalid_response' | 'network';

/** Safe classifications preserve possible spend without retaining credentials, texts or provider bodies. */
export class EmbeddingError extends Error {
  /** A dispatched request may have incurred cost even when its response is unusable. */
  constructor(readonly code: EmbeddingErrorCode, readonly costMayHaveBeenIncurred: boolean) {
    super('Embedding generation failed (' + code + ')'); this.name = 'EmbeddingError';
  }
}
const endpoint = 'https://openrouter.ai/api/v1/embeddings';
const maxResponseBytes = 2 * 1024 * 1024;

export class EmbeddingService {
  private readonly config: EmbeddingProviderConfig;

  /** Keep credentials in a provider-only immutable configuration and reject arbitrary outbound endpoints. */
  constructor(config: EmbeddingProviderConfig, private readonly requestTimeoutMs: number, private readonly fetchImpl: typeof fetch = fetch) {
    try {
      invariant(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1 && requestTimeoutMs <= 120_000
        && typeof fetchImpl === 'function' && (config?.mode === 'fake' || config?.mode === 'live'), 'Invalid embedding configuration');
      if (config.mode === 'live') invariant(config.endpoint === endpoint && identifier(config.model)
        && typeof config.apiKey === 'string' && config.apiKey.length >= 1 && config.apiKey.length <= 4096
        && !/[\s\p{Cc}]/u.test(config.apiKey), 'Invalid embedding credentials');
      this.config = config.mode === 'fake' ? Object.freeze({ mode: 'fake' })
        : Object.freeze({ mode: 'live', endpoint, model: config.model, apiKey: config.apiKey });
    } catch { throw new EmbeddingError('invalid_configuration', false); }
  }

  /** Validate exact input correspondence, issue at most one request, and bound header/body waits by one deadline. */
  async embedTexts(input: EmbeddingInput, signal?: AbortSignal): Promise<EmbeddingResult> {
    let prepared: EmbeddingInput;
    try {
      prepared = prepareEmbeddingInput(input);
      invariant(prepared.model === (this.config.mode === 'fake' ? 'fake' : this.config.model), 'Embedding model binding mismatch');
    } catch { throw new EmbeddingError('invalid_input', false); }
    if (signal?.aborted) throw new EmbeddingError('cancelled', false);
    if (this.config.mode === 'fake') {
      // Deterministic fixtures have no semantic-search quality claim.
      return Object.freeze({ schemaVersion: 1, provider: 'fake', providerRequestId: null, requestedModel: 'fake', model: 'fake',
        dimensions: prepared.dimensions, vectors: Object.freeze(prepared.texts.map(entry => {
          const seed = createHash('sha256').update(entry.text).digest();
          const vector = Array.from({ length: prepared.dimensions }, (_, index) => (seed[index % seed.length]! - 127.5) / 127.5);
          return Object.freeze({ reference: entry.reference, contentHash: entry.contentHash, vector: Object.freeze(vector) });
        })), inputTokens: 0, totalTokens: 0 });
    }
    const config = this.config, controller = new AbortController();
    let dispatched = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectStopped!: (reason: EmbeddingError) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    /** Stop local waits even if an injected or remote transport ignores its abort signal. */
    const stop = (code: 'cancelled' | 'timeout') => {
      rejectStopped(new EmbeddingError(code, dispatched)); controller.abort();
      void reader?.cancel().catch(() => {});
    };
    /** Relay cancellation without retaining its potentially sensitive reason. */
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout'), this.requestTimeoutMs);
    /** Bound the whole response, then parse only the expected vector and usage fields. */
    const request = async (): Promise<EmbeddingResult> => {
      if (signal?.aborted) throw new EmbeddingError('cancelled', false);
      dispatched = true;
      const response = await this.fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: prepared.model, input: prepared.texts.map(entry => entry.text),
          dimensions: prepared.dimensions, encoding_format: 'float' }) });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new EmbeddingError('cancelled', true); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const code: EmbeddingErrorCode = response.status === 401 || response.status === 403 ? 'authentication'
          : response.status === 402 ? 'insufficient_balance' : response.status === 429 ? 'rate_limited'
            : response.status >= 500 ? 'provider_unavailable' : 'invalid_request';
        throw new EmbeddingError(code, true);
      }
      const length = response.headers.get('content-length');
      if (!response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes))) {
        void response.body?.cancel().catch(() => {}); throw new EmbeddingError('invalid_response', true);
      }
      reader = response.body.getReader();
      const bytes = Buffer.alloc(maxResponseBytes); let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw new EmbeddingError('cancelled', true);
        if (chunk.done) break;
        if (chunk.value.byteLength > maxResponseBytes - size) throw new EmbeddingError('invalid_response', true);
        bytes.set(chunk.value, size); size += chunk.value.byteLength;
      }
      try { return parseResult(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))), prepared); }
      catch { throw new EmbeddingError('invalid_response', true); }
    };
    try { return await Promise.race([request(), stopped]); }
    catch (error) { throw error instanceof EmbeddingError ? error : new EmbeddingError('network', dispatched); }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
}

/** External JSON must be object-shaped before its protocol fields can be inspected. */
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Provider IDs/models are bounded metadata, not raw error strings or instructions. */
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= 512 && !/[\s\p{Cc}]/u.test(value); }

/** Explicit indexes restore owner input order and reject duplicates, omissions, wrong shapes or model drift. */
function parseResult(value: unknown, input: EmbeddingInput): EmbeddingResult {
  invariant(record(value) && value.object === 'list' && value.model === input.model && Array.isArray(value.data)
    && value.data.length === input.texts.length, 'Invalid embedding response');
  invariant(value.id === undefined || identifier(value.id), 'Invalid embedding response identity');
  const vectors: EmbeddingResult['vectors'][number][] = new Array(input.texts.length);
  for (const item of value.data) {
    invariant(record(item) && item.object === 'embedding' && Number.isInteger(item.index)
      && (item.index as number) >= 0 && (item.index as number) < input.texts.length, 'Invalid embedding index');
    const index = item.index as number;
    invariant(vectors[index] === undefined && Array.isArray(item.embedding) && item.embedding.length === input.dimensions
      && item.embedding.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate)), 'Invalid embedding vector');
    const source = input.texts[index]!;
    vectors[index] = Object.freeze({ reference: source.reference, contentHash: source.contentHash, vector: Object.freeze([...item.embedding]) });
  }
  let inputTokens: number | null = null, totalTokens: number | null = null;
  if (value.usage !== undefined && value.usage !== null) {
    invariant(record(value.usage) && Number.isSafeInteger(value.usage.prompt_tokens) && (value.usage.prompt_tokens as number) >= 0
      && Number.isSafeInteger(value.usage.total_tokens) && value.usage.total_tokens === value.usage.prompt_tokens, 'Invalid embedding usage');
    inputTokens = value.usage.prompt_tokens as number; totalTokens = value.usage.total_tokens as number;
  }
  return Object.freeze({ schemaVersion: 1, provider: 'openrouter', providerRequestId: (value.id as string | undefined) ?? null,
    requestedModel: input.model, model: input.model, dimensions: input.dimensions, vectors: Object.freeze(vectors), inputTokens, totalTokens });
}
