/**
 * Conversation generation v1. The feature owner selects the text and optional previous Yuna
 * reply before inference. Knowledge, memory, citations and observation remain future capabilities.
 * These values contain no destination authority; generated text cannot redirect delivery.
 */
export interface ReplyGenerationInput {
  readonly text: string;
  readonly previousReply?: string;
  readonly maxOutputTokens: number;
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
