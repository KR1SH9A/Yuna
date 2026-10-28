/** Versioned Debate worker envelopes bind a frozen owner snapshot and one speaker-order variant. */
import type { AssessmentInput, AssessmentResult } from '../../ai/contracts/assessment.contracts.js';
export interface DebateWorkerClaim {
  taskId: string; attemptId: string; generation: number; executorId: string; deadline: string; leaseUntil: string;
  kind: 'debates.assess'; schemaVersion: 1; model: string; promptVersion: string;
}
export interface DebatePreparedPayload { schemaVersion: 1; kind: 'debates.assess'; input: AssessmentInput }
export interface DebateTaskOutcome {
  outcome: 'success' | 'failure' | 'uncertain'; reason: string; payload?: AssessmentResult; providerRequestId?: string | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: string };
}
export interface DebateCompletionReference { taskId: string; resultId: string; sessionId: string }
