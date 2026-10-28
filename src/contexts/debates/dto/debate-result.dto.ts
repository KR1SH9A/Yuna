/** Authorized owner projections distinguish accepted scoring from confirmed publication. */
export interface DebateResultResponseDto {
  readonly sessionId: string; readonly evaluationId: string; readonly transcriptId: string;
  readonly outcome: { kind: 'winner'; userId: string } | { kind: 'tie' | 'uncertain' } | null;
  readonly totals: Readonly<Record<string, string>> | null;
  readonly scores: readonly { criterionId: string; participantId: string; score: string; explanation: string }[] | null;
  readonly limitations: readonly string[] | null;
  readonly publicationState: 'pending' | 'claimed' | 'unknown' | 'published' | 'failed' | 'canceled';
  readonly publicationMessageId: string | null;
}
