/** Durable delivery states, attempt claims and observed outcomes; generation success is never delivery success. */
export type ReplyDeliveryState = 'READY' | 'DISPATCHED' | 'UNKNOWN' | 'DELIVERED' | 'FAILED' | 'CANCELED' | 'EXPIRED';
export interface ReplyAttemptMetadata {
  generation: number;
  executorId: string;
  claimedAt: string;
  sentAt: string | null;
  respondedAt: string | null;
  requestFingerprint: string;
  responseClassification: 'delivered' | 'definitive_failure' | 'unknown' | null;
  reconciliationReference: string | null;
}
export type ReplyOutcome =
  | { classification: 'delivered'; messageId: string; httpStatus?: number }
  | { classification: 'definitive_failure' | 'unknown'; code: string; httpStatus?: number };
export interface ReplyDispatchClaim {
  expectedGeneration: number;
  expectedRowRevision: number;
  sourceVersion: number;
  privacyRevision: number;
  audienceRevision: number;
  executorId: string;
  requestFingerprint: string;
  at: Date;
}
