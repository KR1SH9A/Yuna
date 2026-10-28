/** Versioned, bounded text-to-vector contracts; owners retain consent, retrieval and acceptance decisions. */
import { createHash } from 'node:crypto';
import { invariant } from '../../platform/db/entity-values.js';

export interface EmbeddingText {
  readonly reference: string;
  readonly text: string;
  readonly contentHash: string;
}
export interface EmbeddingInput {
  readonly schemaVersion: 1;
  readonly model: string;
  readonly dimensions: number;
  readonly texts: readonly EmbeddingText[];
}
export interface EmbeddingResult {
  readonly schemaVersion: 1;
  readonly provider: 'openrouter' | 'fake';
  readonly providerRequestId: string | null;
  readonly requestedModel: string;
  readonly model: string;
  readonly dimensions: number;
  readonly vectors: readonly {
    readonly reference: string;
    readonly contentHash: string;
    readonly vector: readonly number[];
  }[];
  /** Missing measurements remain unknown; the caller must not release reserved spend as zero. */
  readonly inputTokens: number | null;
  readonly totalTokens: number | null;
}
export type EmbeddingProviderConfig = { readonly mode: 'fake' } | {
  readonly mode: 'live';
  readonly endpoint: 'https://openrouter.ai/api/v1/embeddings';
  readonly apiKey: string;
  readonly model: string;
};

/** Snapshot exact text/hash/reference bindings before asynchronous disclosure; reject oversized or ambiguous batches. */
export function prepareEmbeddingInput(input: EmbeddingInput): EmbeddingInput {
  invariant(input !== null && typeof input === 'object' && !Array.isArray(input) && input.schemaVersion === 1,
    'Unsupported embedding input');
  invariant(typeof input.model === 'string' && input.model.length > 0 && input.model.length <= 512
    && !/[\s\p{Cc}]/u.test(input.model), 'Invalid embedding model');
  invariant(Number.isSafeInteger(input.dimensions) && input.dimensions >= 1 && input.dimensions <= 4096, 'Invalid embedding dimensions');
  invariant(Array.isArray(input.texts) && input.texts.length >= 1 && input.texts.length <= 16, 'Invalid embedding batch');
  const references = new Set<string>();
  let bytes = 0;
  const texts = input.texts.map(entry => {
    invariant(entry !== null && typeof entry === 'object' && !Array.isArray(entry), 'Invalid embedding text');
    invariant(typeof entry.reference === 'string' && entry.reference.length >= 1 && entry.reference.length <= 256
      && !/[\s\p{Cc}]/u.test(entry.reference) && !references.has(entry.reference), 'Invalid embedding reference');
    invariant(typeof entry.text === 'string' && entry.text.trim().length > 0 && Buffer.byteLength(entry.text, 'utf8') <= 8192,
      'Invalid embedding text size');
    invariant(entry.contentHash === createHash('sha256').update(entry.text).digest('hex'), 'Embedding content hash mismatch');
    bytes += Buffer.byteLength(entry.text, 'utf8'); references.add(entry.reference);
    invariant(bytes <= 64 * 1024, 'Embedding batch exceeds byte bound');
    return Object.freeze({ reference: entry.reference, text: entry.text, contentHash: entry.contentHash });
  });
  return Object.freeze({ schemaVersion: 1, model: input.model, dimensions: input.dimensions, texts: Object.freeze(texts) });
}
