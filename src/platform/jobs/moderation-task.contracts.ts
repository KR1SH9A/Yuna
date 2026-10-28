/** Versioned moderation execution envelopes; worker values never select owner workflow transitions. */
import type { ObservationInput, ObservationResult } from '../../ai/contracts/observation.contracts.js';
import type { AssessmentInput, AssessmentResult } from '../../ai/contracts/assessment.contracts.js';

export type ModerationTaskKind = 'moderation.observe' | 'moderation.assess';
export interface ModerationWorkerClaim {
  taskId: string; attemptId: string; generation: number; executorId: string; deadline: string; leaseUntil: string;
  kind: ModerationTaskKind; schemaVersion: 1; model: string; promptVersion: string;
}
export type ModerationPreparedPayload =
  | { schemaVersion: 1; kind: 'moderation.observe'; input: ObservationInput }
  | { schemaVersion: 1; kind: 'moderation.assess'; input: AssessmentInput; observation: ObservationResult; observationResultId: string };
export interface ModerationTaskOutcome {
  outcome: 'success' | 'failure' | 'uncertain'; reason: string;
  payload?: ObservationResult | AssessmentResult;
  providerRequestId?: string | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: string };
}
export interface ModerationCompletionReference { taskId: string; resultId: string; caseId: string }
