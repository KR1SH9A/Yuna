/** Plain immutable evidence, policy and decision values; no provider output carries authority. */
import type { AssessmentResult } from '../../ai/contracts/assessment.contracts.js';
import type { CaptureCoverage, OriginalAttachmentDescriptor } from './entities/evidence-revision.entity.js';
import type { ModerationPolicyConfiguration } from '../../platform/config/policy-config.js';

export interface EvidenceBinding {
  readonly guildId: string;
  readonly installationId: string;
  readonly caseId: string;
  readonly evidenceRevisionId: string;
  readonly originalEventId: string;
  readonly contentHash: string | null;
  readonly sourceUse: 'original_evidence';
}
export interface ModerationEvidence extends EvidenceBinding {
  readonly originalContent: string | null;
  readonly authorKind: 'user' | 'bot' | 'webhook' | 'system' | 'unknown';
  readonly originalAuthorUserId: string | null;
  readonly attachments: readonly OriginalAttachmentDescriptor[];
  readonly captureCoverage: CaptureCoverage;
  readonly missingReasons: readonly string[];
  readonly available: boolean;
}
/** Facts quote exact retained body spans. An observation cannot create missing original evidence. */
export interface SupportedBodyFact { readonly statement: string; readonly quote: string; readonly start: number; readonly end: number }
export interface ModerationObservation {
  readonly evidenceRevisionId: string;
  readonly inspectedBody: boolean;
  readonly facts: readonly SupportedBodyFact[];
  readonly limitations: readonly string[];
}
export interface ModerationPolicySnapshot extends ModerationPolicyConfiguration { readonly id: string }
export type ModerationDisposition = 'violation' | 'suspicion' | 'clear' | 'incomplete';
export interface ModerationRuleDecision {
  readonly ruleId: string;
  readonly disposition: ModerationDisposition;
  readonly reasonCode: string;
  readonly supportedFacts: readonly SupportedBodyFact[];
  /** Proposal only. The application must persist findings and pass fresh authority/dispatch gates. */
  readonly proposedAction: 'ban' | 'warning' | 'none';
  readonly deleteMessageSeconds: number;
}
export interface RuleDecisionInput {
  readonly enabled: boolean;
  readonly policy: ModerationPolicySnapshot;
  readonly ruleId: string;
  readonly evidence: ModerationEvidence;
  readonly observation: ModerationObservation;
  readonly assessment: AssessmentResult | null;
}
