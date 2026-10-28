/** Plain routing, result and timing values shared by the conversation owner and restricted worker. */
import type { ReplyGenerationResult } from '../../ai/contracts/generation.contracts.js';

/** Routing and lease authority only; payload is disclosed by a separate database operation. */
export interface WorkerClaim {
  taskId: string;
  attemptId: string;
  generation: number;
  executorId: string;
  deadline: string;
  leaseUntil: string;
  kind: 'community.generate';
  schemaVersion: 1;
  model: string;
  promptVersion: string;
}

export interface ConversationTaskOutcome {
  outcome: 'success' | 'failure' | 'uncertain';
  reason: string;
  payload?: ReplyGenerationResult;
  providerRequestId?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
}

/** Stored completion routing for the Community owner; never supplied by model output. */
export interface ConversationTaskCompletion {
  taskId: string;
  resultId: string;
  requestId: string;
  sourceEventId: string;
  sourceRevision: number;
  safetyRevision: number;
  outcome: 'success' | 'failure' | 'uncertain' | 'canceled' | 'expired';
  payload: ReplyGenerationResult | null;
  /** Existing durable timestamps permit timing reports without retaining extra message data. */
  resultCreatedAt: Date | string;
  queueWaitMs: number | null;
}

export interface ConversationTaskScope { installationId: string; guildId: string }
