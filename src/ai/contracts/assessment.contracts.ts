/** Versioned, text-only assessment values; owners supply meaning/evidence and retain all action authority. */
import type { JsonObject } from '../../platform/db/entity-values.js';

/** Choose one caller-defined label. Version 1 uses short strings rather than arbitrary structured instructions. */
export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** Evaluate the probability of a proposition; a middle probability is not a boolean finding. */
export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria?: Readonly<{ true: string; false: string }>;
}

/** Rate against ordered descriptions numbered from zero; scores retain their original scale. */
export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export type AssessmentQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

/** Prepared owner data only: state may include attributable text, observations and explicit coverage gaps. */
export interface AssessmentInput {
  readonly schemaVersion: 1;
  readonly configurationVersion: string;
  readonly state: JsonObject;
  readonly questions: Readonly<Record<string, AssessmentQuestion>>;
  /** Caller-supplied bindings echoed locally; Jev does not generate source citations. */
  readonly sourceReferences: readonly string[];
}

export type AssessmentAnswer = Readonly<{
  type: 'choice'; choice: string; confidence: number; probabilities: Readonly<Record<string, number>>;
}> | Readonly<{
  type: 'noul'; noul: number;
}> | Readonly<{
  type: 'score'; score: number; confidence: number; probabilities: Readonly<Record<string, number>>;
  legend: Readonly<Record<string, string>>;
}>;

/** A valid assessment is still advisory; the owning policy evaluates uncertainty and permitted actions. */
export interface AssessmentResult {
  readonly schemaVersion: 1;
  readonly configurationVersion: string;
  readonly sourceReferences: readonly string[];
  readonly outcome: 'assessed' | 'uncertain';
  readonly uncertaintyReason: 'fake_provider' | null;
  readonly answers: Readonly<Record<string, AssessmentAnswer>>;
  readonly requestedModel: string;
  readonly model: string;
  readonly providerRequestId: string | null;
  readonly provider: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Decimal USD as reported in the response, preserving its numeric spelling without inventing billing precision. */
  readonly costUsd: string;
}
