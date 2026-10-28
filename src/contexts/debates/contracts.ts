/** Narrow Debate publication and frozen scoring values; adapters never receive ORM entities. */
export interface DebateRubricInput {
  readonly criteria: readonly { readonly id: string; readonly description: string; readonly levels: readonly string[]; readonly weight: string }[];
  readonly minimumWinningMargin: string;
  readonly minimumConfidence: number;
  readonly paired: boolean;
  readonly maximumPairDifference: number;
}

/** Consent covers explicit submitted text, the selected rubric and the named publication channel. */
export interface DebatePublicationRequest {
  readonly guildId: string; readonly channelId: string; readonly evaluationId: string;
  readonly content: string; readonly nonce: string; readonly contentHash: string; readonly deadline: Date;
}
export type DebatePublicationOutcome = { readonly classification: 'confirmed'; readonly messageId: string }
  | { readonly classification: 'rejected' | 'unknown'; readonly code: string };
export interface DebatePublicationTransport {
  /** Read current channel permissions before the owner commits its publication claim. */
  prepare(input: { guildId: string; channelId: string }, signal: AbortSignal): Promise<{ allowed: boolean; observedAt: Date }>;
  /** Send once with an empty allowed-mentions policy and the committed nonce. */
  send(input: DebatePublicationRequest, signal: AbortSignal): Promise<DebatePublicationOutcome>;
  /** Match channel, bot, nonce and content hash; absence remains uncertainty. */
  reconcile(input: Omit<DebatePublicationRequest, 'content' | 'deadline'>, signal: AbortSignal): Promise<string | null>;
}
