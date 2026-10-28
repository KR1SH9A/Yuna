/** Bounded moderation intake arguments and progress; trusted transport identity is supplied separately. */
import type { OriginalMessageCapture } from '../../../platform/intake/intake.service.js';
import type { ModerationDisposition } from '../contracts.js';

export type IngestMessageDto = OriginalMessageCapture;
export interface ReportMessageDto { readonly channelId: string; readonly messageId: string; readonly allegation: string }
export interface ModerationCaseDto {
  readonly caseId: string;
  readonly evidenceRevisionId: string | null;
  readonly policyRevisionId: string;
  readonly phase: 'awaiting_original' | 'captured' | 'observing' | 'assessing' | 'complete';
  readonly disposition: ModerationDisposition | null;
  readonly reasonCode: string | null;
  readonly duplicate: boolean;
}
export type ModerationIntakeResult =
  | { readonly status: 'recorded'; readonly case: ModerationCaseDto }
  | { readonly status: 'ignored'; readonly reasonCode: 'admission_closed' | 'policy_missing' };
