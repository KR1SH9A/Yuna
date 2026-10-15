import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

import type { EvaluationVariant } from './debate-session.entity.js';

export interface CriterionScore { criterionId: string; participantId: string; score: string; explanation: string }
export interface EvaluationCitation { criterionId: string; entryId: string; quotation: string | null }
export type DebateOutcome = { kind: 'winner'; userId: string } | { kind: 'tie' | 'uncertain' };
export interface PublicationAttempt {
  generation: number;
  executorId: string;
  claimedAt: string;
  leaseUntil: string;
  nonce: string;
  requestFingerprint: string;
  sentAt: string | null;
  nextAttemptAt: string | null;
  responseClass: 'confirmed' | 'rejected' | 'unknown' | null;
  reasonCode: string | null;
}
export interface DebateEvaluationInput extends ScopedEntityInput {
  acceptanceOperationKey: string;
  sessionId: string;
  transcriptSnapshotId: string;
  rubricRevisionId: string;
  acceptedResults: Partial<Record<EvaluationVariant, string>>;
  criterionScores: readonly CriterionScore[];
  evidenceReferences: readonly EvaluationCitation[];
  totals: Readonly<Record<string, string>>;
  outcome: DebateOutcome;
  limitations: readonly string[];
  acceptedAt: Date;
  publicationDestination: { channelId: string; allowedMentionUserIds: readonly string[] };
  purgeAfter: Date;
}

/** Accepted scoring data survives Jobs cleanup; publication uncertainty never invents a success. */
@Entity({ tableName: 'debate_evaluation' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'acceptanceOperationKey'] })
@Check({ name: 'debate_evaluation_check_1', expression: `"publication_state" in ('pending', 'claimed', 'unknown', 'published', 'failed', 'canceled')` })
@Check({ name: 'debate_evaluation_check_2', expression: `("publication_state" = 'published') = ("publication_message_id" is not null and "published_at" is not null)` })
@Check({ name: 'debate_evaluation_check_3', expression: '"row_revision" >= 1' })
export class DebateEvaluation extends ScopedEntity {
  @Property({ type: 'text' }) readonly acceptanceOperationKey: string;
  @Property({ type: 'uuid' }) readonly sessionId: string;
  @Property({ type: 'uuid' }) readonly transcriptSnapshotId: string;
  @Property({ type: 'uuid' }) readonly rubricRevisionId: string;
  @Property({ type: 'json' }) readonly acceptedResults: Partial<Record<EvaluationVariant, string>>;
  @Property({ type: 'json', nullable: true }) criterionScores: readonly CriterionScore[] | null;
  @Property({ type: 'json', nullable: true }) evidenceReferences: readonly EvaluationCitation[] | null;
  @Property({ type: 'json', nullable: true }) totals: Readonly<Record<string, string>> | null;
  @Property({ type: 'json', nullable: true }) outcome: DebateOutcome | null;
  @Property({ type: 'json', nullable: true }) limitations: readonly string[] | null;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly acceptedAt: Date;
  @Property({ type: 'text' }) publicationState: 'pending' | 'claimed' | 'unknown' | 'published' | 'failed' | 'canceled' = 'pending';
  @Property({ type: 'json' }) readonly publicationDestination: DebateEvaluationInput['publicationDestination'];
  @Property({ type: 'text', nullable: true }) publicationMessageId: string | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) publishedAt: Date | null = null;
  @Property({ type: 'json', nullable: true }) publicationAttempt: PublicationAttempt | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  constructor(input: DebateEvaluationInput) {
    super(input);
    assertUuid(input.sessionId);
    assertUuid(input.transcriptSnapshotId);
    assertUuid(input.rubricRevisionId);
    Object.values(input.acceptedResults).forEach(assertUuid);
    assertDate(input.acceptedAt, 'acceptedAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    assertDiscordId(input.publicationDestination.channelId);
    input.publicationDestination.allowedMentionUserIds.forEach(assertDiscordId);
    invariant(input.acceptanceOperationKey.length > 0 && !!input.acceptedResults.original, 'Evaluation acceptance identity and original result are required');
    invariant(input.purgeAfter > input.acceptedAt, 'Evaluation retention is invalid');
    invariant(input.criterionScores.length > 0, 'Accepted scores are required');
    const scoreKeys = new Set<string>();
    for (const score of input.criterionScores) {
      assertDiscordId(score.participantId);
      invariant(score.criterionId.length > 0 && /^\d+(?:\.\d+)?$/.test(score.score), 'Invalid criterion score');
      const key = `${score.criterionId}:${score.participantId}`;
      invariant(!scoreKeys.has(key), 'Duplicate participant criterion score');
      scoreKeys.add(key);
    }
    input.evidenceReferences.forEach(citation => assertUuid(citation.entryId));
    for (const [participantId, total] of Object.entries(input.totals)) {
      assertDiscordId(participantId);
      invariant(/^\d+(?:\.\d+)?$/.test(total), 'Totals must use exact nonnegative decimals');
    }
    invariant(Object.keys(input.totals).length > 0, 'Deterministically calculated totals are required');
    if (input.outcome.kind === 'winner') {
      assertDiscordId(input.outcome.userId);
      invariant(Object.hasOwn(input.totals, input.outcome.userId), 'Winner must be an evaluated participant');
    }
    this.acceptanceOperationKey = input.acceptanceOperationKey;
    this.sessionId = input.sessionId;
    this.transcriptSnapshotId = input.transcriptSnapshotId;
    this.rubricRevisionId = input.rubricRevisionId;
    this.acceptedResults = copyJson(input.acceptedResults);
    this.criterionScores = copyJson(input.criterionScores);
    this.evidenceReferences = copyJson(input.evidenceReferences);
    this.totals = copyJson(input.totals);
    this.outcome = copyJson(input.outcome);
    this.limitations = copyJson(input.limitations);
    this.acceptedAt = new Date(input.acceptedAt);
    this.publicationDestination = copyJson(input.publicationDestination);
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(input.acceptedAt);
  }

  /** Commit this claim before sending. A prior unknown send is never claimable. */
  claimPublication(input: { expectedGeneration: number; executorId: string; nonce: string; requestFingerprint: string; leaseUntil: Date; at: Date }): number {
    invariant(this.publicationState === 'pending' || this.publicationState === 'failed', 'Publication is not claimable');
    const generation = this.publicationAttempt?.generation ?? 0;
    invariant(input.expectedGeneration === generation && generation < 2_147_483_647, 'Publication generation is stale or exhausted');
    this.assertMutable(input.at);
    invariant(!this.payloadPurgedAt && input.at < this.purgeAfter, 'Accepted evaluation content is unavailable');
    assertDate(input.leaseUntil, 'leaseUntil');
    invariant(input.leaseUntil > input.at && input.executorId.length > 0, 'Invalid publication lease');
    invariant(input.nonce.length > 0 && input.nonce.length <= 25 && input.requestFingerprint.length > 0, 'Invalid publication request binding');
    this.publicationAttempt = {
      generation: generation + 1, executorId: input.executorId, nonce: input.nonce,
      requestFingerprint: input.requestFingerprint, claimedAt: input.at.toISOString(),
      leaseUntil: input.leaseUntil.toISOString(), sentAt: null, nextAttemptAt: null,
      responseClass: null, reasonCode: null,
    };
    this.publicationState = 'claimed';
    this.touch(input.at);
    return generation + 1;
  }

  markPublicationSent(generation: number, at: Date): void {
    this.assertAttempt(generation);
    invariant(this.publicationState === 'claimed', 'Publication is not claimed');
    this.assertMutable(at);
    this.publicationAttempt = { ...this.publicationAttempt!, sentAt: at.toISOString() };
    this.touch(at);
  }

  recordPublication(generation: number, messageId: string, at: Date): void {
    this.assertAttempt(generation);
    assertDiscordId(messageId);
    if (this.publicationState === 'published' && this.publicationMessageId === messageId) return;
    invariant(this.publicationState === 'claimed' || this.publicationState === 'unknown', 'Publication has no unresolved attempt');
    this.assertMutable(at);
    this.publicationState = 'published';
    this.publicationMessageId = messageId;
    this.publishedAt = new Date(at);
    this.publicationAttempt = { ...this.publicationAttempt!, responseClass: 'confirmed', nextAttemptAt: null, reasonCode: null };
    this.touch(at);
  }

  recordPublicationUncertainty(generation: number, reasonCode: string, at: Date): void {
    this.assertAttempt(generation);
    invariant(this.publicationState === 'claimed' || this.publicationState === 'unknown', 'Publication is not unresolved');
    this.assertMutable(at);
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded reason code is required');
    this.publicationState = 'unknown';
    this.publicationAttempt = { ...this.publicationAttempt!, responseClass: 'unknown', reasonCode };
    this.touch(at);
  }

  /** Only attributable rejection/no-send evidence permits a subsequent fresh attempt. */
  recordPublicationRejection(generation: number, reasonCode: string, at: Date): void {
    this.assertAttempt(generation);
    invariant(this.publicationState === 'claimed' || this.publicationState === 'unknown', 'Publication has no unresolved attempt');
    this.assertMutable(at);
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded rejection code is required');
    this.publicationState = 'failed';
    this.publicationAttempt = { ...this.publicationAttempt!, responseClass: 'rejected', reasonCode, nextAttemptAt: null };
    this.touch(at);
  }

  schedulePublicationRecovery(generation: number, nextAttemptAt: Date, at: Date): void {
    this.assertAttempt(generation);
    invariant(this.publicationState === 'unknown' || this.publicationState === 'failed', 'Publication is not recoverable');
    this.assertMutable(at);
    assertDate(nextAttemptAt, 'nextAttemptAt');
    invariant(nextAttemptAt >= at, 'Recovery time predates its observation');
    this.publicationAttempt = { ...this.publicationAttempt!, nextAttemptAt: nextAttemptAt.toISOString() };
    this.touch(at);
  }

  cancelPublication(at: Date): void {
    if (this.publicationState === 'canceled') return;
    invariant(this.publicationState === 'pending' || this.publicationState === 'failed', 'Dispatched publication must reconcile before cancellation');
    this.assertMutable(at);
    this.publicationState = 'canceled';
    this.touch(at);
  }

  purgePayload(reasonCode: string, at: Date): void {
    if (this.payloadPurgedAt) return;
    this.assertMutable(at);
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded purge reason is required');
    if (this.publicationState === 'pending' || this.publicationState === 'failed') this.publicationState = 'canceled';
    if (this.publicationState === 'claimed') {
      this.publicationState = 'unknown';
      this.publicationAttempt = { ...this.publicationAttempt!, responseClass: 'unknown', reasonCode: 'payload_purged_after_claim' };
    }
    this.criterionScores = null;
    this.evidenceReferences = null;
    this.totals = null;
    this.outcome = null;
    this.limitations = null;
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reasonCode;
    this.touch(at);
  }

  private assertAttempt(generation: number): void {
    invariant(this.publicationAttempt !== null && this.publicationAttempt.generation === generation, 'Stale publication attempt');
  }

  private assertMutable(at: Date): void {
    assertDate(at, 'at');
    invariant(this.rowRevision < 2_147_483_647, 'Revision exhausted');
  }

  private touch(at: Date): void { this.rowRevision += 1; this.updatedAt = new Date(at); }
}
