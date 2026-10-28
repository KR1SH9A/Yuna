/**
 * Conversation generation v1. The feature owner selects the text and optional previous Yuna
 * reply and approved visible knowledge before inference. Personal memory remains a separate capability.
 * These values contain no destination authority; generated text cannot redirect delivery.
 */
import { createHash } from 'node:crypto';
import { assertNonNegativeInteger, assertUuid, invariant } from '../../platform/db/entity-values.js';

/** Approved values are contextual data; these references cannot authorize actions or redirect a reply. */
export interface ApprovedKnowledgeContext { readonly entryId: string; readonly content: string; readonly contentHash: string; readonly revision: number }

export interface ReplyGenerationInput {
  readonly text: string;
  readonly previousReply?: string;
  readonly approvedKnowledge?: readonly ApprovedKnowledgeContext[];
  readonly maxOutputTokens: number;
}

/** Copy and validate one bounded reply payload at both the owner and provider boundaries. */
export function prepareReplyGenerationInput(input: ReplyGenerationInput): ReplyGenerationInput {
  invariant(input !== null && typeof input === 'object' && !Array.isArray(input), 'Generation input must be an object');
  invariant(typeof input.text === 'string' && input.text.trim().length > 0 && input.text.length <= 4_000, 'Generation text must contain 1 to 4000 characters');
  invariant(input.previousReply === undefined || (typeof input.previousReply === 'string' && input.previousReply.length <= 2_000), 'Previous reply must contain at most 2000 characters');
  assertNonNegativeInteger(input.maxOutputTokens, 'Output token limit');
  invariant(input.maxOutputTokens > 0 && input.maxOutputTokens <= 1_024, 'Output token limit must be between 1 and 1024');
  let approvedKnowledge: readonly ApprovedKnowledgeContext[] | undefined;
  if (input.approvedKnowledge !== undefined) {
    invariant(Array.isArray(input.approvedKnowledge) && input.approvedKnowledge.length <= 5, 'Invalid approved knowledge count');
    invariant(new Set(input.approvedKnowledge.map(entry => entry.entryId)).size === input.approvedKnowledge.length, 'Duplicate approved knowledge entry');
    approvedKnowledge = Object.freeze(input.approvedKnowledge.map(entry => {
      assertUuid(entry.entryId); assertNonNegativeInteger(entry.revision, 'Knowledge revision');
      invariant(entry.revision >= 1 && typeof entry.content === 'string' && entry.content.trim().length > 0 && entry.content.length <= 6_000, 'Invalid approved knowledge entry');
      invariant(entry.contentHash === createHash('sha256').update(entry.content).digest('hex'), 'Approved knowledge hash mismatch');
      return Object.freeze({ entryId: entry.entryId, content: entry.content, contentHash: entry.contentHash, revision: entry.revision });
    }));
  }
  invariant(input.text.length + (input.previousReply?.length ?? 0) + (approvedKnowledge?.reduce((sum, entry) => sum + entry.content.length, 0) ?? 0) <= 6_000,
    'Combined reply context exceeds 6000 characters');
  const result = Object.freeze({ text: input.text, ...(input.previousReply === undefined ? {} : { previousReply: input.previousReply }),
    ...(approvedKnowledge?.length ? { approvedKnowledge } : {}), maxOutputTokens: input.maxOutputTokens });
  invariant(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 28 * 1024, 'Reply input exceeds byte bound');
  return result;
}

/** Validated provider measurements are token counts, not a computed monetary charge. */
export interface ReplyGenerationResult {
  readonly text: string;
  readonly providerRequestId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly truncated: boolean;
}
