/** Persist accepted reply content, one dispatch attempt and uncertainty without confusing acceptance with delivery. */
import { createHash } from 'node:crypto';
import { Check, Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';
import { nextRevision, validateAudience, validateContinuation, validateMentions, type AllowedMentions, type AudienceBinding, type ContextBinding, type InteractionContinuation } from './community-values.js';

import type { ReplyDestination } from '../contracts.js';
export type { ReplyDestination } from '../contracts.js';
export interface ReplyDeliveryInput extends ScopedEntityInput {
  requestId: string;
  acceptedResultReference: string;
  acceptedContent: string;
  supportingReferences: ContextBinding[];
  allowedMentions: AllowedMentions;
  destination: ReplyDestination;
  sourceVersion: number;
  privacyRevision: number;
  audienceBinding: AudienceBinding;
  deadline: Date;
  purgeAfter: Date;
  maxAttempts: number;
}
import type { ReplyDeliveryState, ReplyAttemptMetadata, ReplyOutcome, ReplyDispatchClaim } from '../dto/reply-delivery.dto.js';
export type { ReplyDeliveryState, ReplyAttemptMetadata, ReplyOutcome, ReplyDispatchClaim } from '../dto/reply-delivery.dto.js';

/** Accepted content survives Jobs cleanup. This row alone describes what happened to the reply. */
@Check({ name: 'reply_delivery_check_1', expression: "state IN ('READY', 'DISPATCHED', 'UNKNOWN', 'DELIVERED', 'FAILED', 'CANCELED', 'EXPIRED')" })
@Check({ name: 'reply_delivery_check_2', expression: "(transport = 'channel_message' AND channel_id IS NOT NULL AND nonce IS NOT NULL AND length(nonce) BETWEEN 1 AND 25 AND enforce_nonce IS NOT NULL AND application_id IS NULL AND interaction_id IS NULL AND token_ciphertext IS NULL AND token_key_id IS NULL AND token_expires_at IS NULL AND ephemeral IS NULL AND acknowledgment IS NULL AND acknowledged_at IS NULL) OR (transport = 'interaction_original' AND channel_id IS NULL AND reply_message_id IS NULL AND nonce IS NULL AND enforce_nonce IS NULL AND application_id IS NOT NULL AND interaction_id IS NOT NULL AND token_expires_at IS NOT NULL AND ephemeral IS NOT NULL AND acknowledgment IS NOT NULL AND acknowledgment = 'deferred' AND acknowledged_at IS NOT NULL)" })
@Check({ name: 'reply_delivery_check_3', expression: "(token_ciphertext IS NULL) = (token_key_id IS NULL)" })
@Check({ name: 'reply_delivery_check_4', expression: "state <> 'DELIVERED' OR discord_message_id IS NOT NULL" })
@Check({ name: 'reply_delivery_check_5', expression: "state <> 'READY' OR (accepted_content IS NOT NULL AND (transport <> 'interaction_original' OR token_ciphertext IS NOT NULL))" })
@Check({ name: 'reply_delivery_check_6', expression: "accepted_content IS NULL OR length(accepted_content) BETWEEN 1 AND 2000" })
@Check({ name: 'reply_delivery_check_7', expression: "(payload_purged_at IS NULL AND purge_reason IS NULL AND accepted_content IS NOT NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND accepted_content IS NULL AND supporting_references IS NULL AND allowed_mentions IS NULL)" })
@Check({ name: 'reply_delivery_check_8', expression: "max_attempts > 0 AND attempt_count >= 0 AND attempt_count <= max_attempts AND generation >= 0 AND row_revision > 0" })
@Entity({ tableName: 'reply_delivery' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'requestId'] })
@Index({ properties: ['state', 'nextAttemptAt'] })
export class ReplyDelivery extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly requestId: string;
  @Property({ type: 'uuid' }) readonly acceptedResultReference: string;
  @Property({ type: 'text', nullable: true }) acceptedContent: string | null;
  @Property({ type: 'text' }) readonly contentHash: string;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) supportingReferences: ContextBinding[] | null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) allowedMentions: AllowedMentions | null;
  @Property({ type: 'text' }) readonly transport: ReplyDestination['transport'];
  @Property({ type: 'text', nullable: true }) readonly channelId: string | null;
  @Property({ type: 'text', nullable: true }) readonly replyMessageId: string | null;
  @Property({ type: 'text', nullable: true }) readonly nonce: string | null;
  @Property({ type: 'boolean', nullable: true }) readonly enforceNonce: boolean | null;
  @Property({ type: 'text', nullable: true }) readonly applicationId: string | null;
  @Property({ type: 'text', nullable: true }) readonly interactionId: string | null;
  @Property({ type: 'text', nullable: true, hidden: true }) tokenCiphertext: string | null;
  @Property({ type: 'text', nullable: true, hidden: true }) tokenKeyId: string | null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly tokenExpiresAt: Date | null;
  @Property({ type: 'boolean', nullable: true }) readonly ephemeral: boolean | null;
  @Property({ type: 'text', nullable: true }) readonly acknowledgment: 'deferred' | null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly acknowledgedAt: Date | null;
  @Property({ type: 'integer' }) readonly sourceVersion: number;
  @Property({ type: 'integer' }) readonly privacyRevision: number;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly audienceBinding: AudienceBinding;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly deadline: Date;
  @Property({ type: 'text' }) state: ReplyDeliveryState = 'READY';
  @Property({ type: 'integer' }) generation = 0;
  @Property({ type: 'integer' }) attemptCount = 0;
  @Property({ type: 'integer' }) readonly maxAttempts: number;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) attempt: ReplyAttemptMetadata | null = null;
  @Property({ type: 'text', nullable: true }) discordMessageId: string | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) nextAttemptAt: Date | null = null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) outcomeDetails: ReplyOutcome | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  /** Copy the accepted text and exact destination into a durable intent whose deadline and retention are bounded. */
  constructor(input: ReplyDeliveryInput) {
    super(input);
    assertUuid(input.requestId);
    assertUuid(input.acceptedResultReference);
    invariant(input.acceptedContent.length > 0 && input.acceptedContent.length <= 2000, 'Accepted reply must fit one Discord message');
    invariant(input.supportingReferences.length <= 100, 'Reply references must be bounded');
    validateMentions(input.allowedMentions);
    validateAudience(input.audienceBinding);
    for (const [label, value] of [['sourceVersion', input.sourceVersion], ['privacyRevision', input.privacyRevision], ['maxAttempts', input.maxAttempts]] as const) {
      assertNonNegativeInteger(value, label);
      invariant(value <= 2147483647, `${label} exceeds storage range`);
    }
    invariant(input.maxAttempts > 0, 'Delivery requires an explicit positive attempt bound');
    assertDate(input.deadline, 'deadline');
    assertDate(input.purgeAfter, 'purgeAfter');
    invariant(input.deadline > this.createdAt && input.purgeAfter >= input.deadline, 'Delivery deadline must fit accepted content retention');
    this.transport = input.destination.transport;
    if (input.destination.transport === 'channel_message') {
      assertDiscordId(input.destination.channelId);
      if (input.destination.replyMessageId) assertDiscordId(input.destination.replyMessageId);
      invariant(input.destination.nonce.length > 0 && input.destination.nonce.length <= 25, 'Message nonce must have at most 25 characters');
      invariant(input.audienceBinding.visibility === 'channel' && input.audienceBinding.channelId === input.destination.channelId, 'A channel send must match its channel audience');
      this.channelId = input.destination.channelId;
      this.replyMessageId = input.destination.replyMessageId;
      this.nonce = input.destination.nonce;
      this.enforceNonce = input.destination.enforceNonce;
      this.applicationId = null;
      this.interactionId = null;
      this.tokenCiphertext = null;
      this.tokenKeyId = null;
      this.tokenExpiresAt = null;
      this.ephemeral = null;
      this.acknowledgment = null;
      this.acknowledgedAt = null;
    } else {
      const continuation = input.destination.continuation;
      validateContinuation(continuation, this.createdAt);
      invariant(continuation.ephemeral === (input.audienceBinding.visibility === 'requester'), 'Interaction audience cannot change its deferred ephemeral choice');
      this.channelId = null;
      this.replyMessageId = null;
      this.nonce = null;
      this.enforceNonce = null;
      this.applicationId = continuation.applicationId;
      this.interactionId = continuation.interactionId;
      this.tokenCiphertext = continuation.tokenCiphertext;
      this.tokenKeyId = continuation.tokenKeyId;
      this.tokenExpiresAt = new Date(continuation.tokenExpiresAt);
      this.ephemeral = continuation.ephemeral;
      this.acknowledgment = continuation.acknowledgment;
      this.acknowledgedAt = new Date(continuation.acknowledgedAt);
    }
    this.requestId = input.requestId;
    this.acceptedResultReference = input.acceptedResultReference;
    this.acceptedContent = input.acceptedContent;
    this.contentHash = createHash('sha256').update(input.acceptedContent).digest('hex');
    this.supportingReferences = copyJson(input.supportingReferences);
    this.allowedMentions = copyJson(input.allowedMentions);
    this.sourceVersion = input.sourceVersion;
    this.privacyRevision = input.privacyRevision;
    this.audienceBinding = copyJson(input.audienceBinding);
    this.deadline = new Date(input.deadline);
    this.purgeAfter = new Date(input.purgeAfter);
    this.maxAttempts = input.maxAttempts;
    this.updatedAt = new Date(this.createdAt);
  }

  /** Consume one eligible dispatch opportunity and bind its generation, executor and endpoint fingerprint. */
  claimDispatch(input: ReplyDispatchClaim): number {
    this.check(input.expectedRowRevision, input.at);
    invariant(this.state === 'READY' && this.generation === input.expectedGeneration, 'Reply is not ready for this generation');
    invariant(this.sourceVersion === input.sourceVersion && this.privacyRevision === input.privacyRevision && this.audienceBinding.revision === input.audienceRevision, 'Reply bindings are no longer current');
    invariant(input.at < this.deadline && input.at < this.purgeAfter && this.acceptedContent !== null, 'Reply content or deadline is unavailable');
    invariant(this.nextAttemptAt === null || this.nextAttemptAt <= input.at, 'Retry is not due');
    invariant(this.attemptCount < this.maxAttempts, 'Reply attempt bound reached');
    if (this.transport === 'interaction_original') invariant(this.tokenCiphertext !== null && this.tokenKeyId !== null && this.tokenExpiresAt !== null && this.tokenExpiresAt > input.at, 'Interaction continuation has expired or been purged');
    invariant(input.executorId.length > 0 && input.executorId.length <= 200, 'Executor identity must be bounded');
    invariant(/^[a-f0-9]{64}$/.test(input.requestFingerprint), 'Request requires a SHA-256 fingerprint');
    this.generation = nextRevision(this.generation);
    this.attemptCount = nextRevision(this.attemptCount);
    this.attempt = { generation: this.generation, executorId: input.executorId, claimedAt: input.at.toISOString(), sentAt: null, respondedAt: null, requestFingerprint: input.requestFingerprint, responseClassification: null, reconciliationReference: null };
    this.state = 'DISPATCHED';
    this.nextAttemptAt = null;
    this.touch(input.at);
    return this.generation;
  }

  /** Record that the current attempt may reach Discord before starting external I/O. */
  markSent(generation: number, expectedRowRevision: number, at: Date): void {
    this.checkAttempt(generation, expectedRowRevision, at, 'DISPATCHED');
    invariant(this.attempt !== null, 'Missing attempt');
    if (this.attempt.sentAt !== null) return;
    this.attempt = { ...this.attempt, sentAt: at.toISOString() };
    this.touch(at);
  }

  /** Apply the observed transport result only to the still-current dispatched attempt. */
  recordOutcome(generation: number, outcome: ReplyOutcome, expectedRowRevision: number, at: Date): void {
    this.checkAttempt(generation, expectedRowRevision, at, 'DISPATCHED');
    this.applyOutcome(outcome, at);
  }

  /** Resolve an unknown send only when attributable evidence refers to this exact attempt. */
  recordReconciliation(generation: number, outcome: ReplyOutcome, evidenceReference: string, expectedRowRevision: number, at: Date): void {
    this.checkAttempt(generation, expectedRowRevision, at, 'UNKNOWN');
    invariant(evidenceReference.length > 0 && evidenceReference.length <= 200, 'Reconciliation requires bounded attributable evidence');
    invariant(this.attempt !== null, 'Missing attempt');
    this.attempt = { ...this.attempt, reconciliationReference: evidenceReference };
    this.applyOutcome(outcome, at);
  }

  /** Allow a bounded retry only after a definitive failure, never after an unknown send. */
  scheduleRetry(nextAttemptAt: Date, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    assertDate(nextAttemptAt, 'nextAttemptAt');
    invariant(this.state === 'FAILED' && this.outcomeDetails?.classification === 'definitive_failure', 'An uncertain send is not retryable');
    invariant(nextAttemptAt >= at && nextAttemptAt < this.deadline && nextAttemptAt < this.purgeAfter && this.acceptedContent !== null && this.attemptCount < this.maxAttempts, 'Retry exceeds delivery eligibility');
    if (this.transport === 'interaction_original') invariant(this.tokenCiphertext !== null && this.tokenExpiresAt !== null && nextAttemptAt < this.tokenExpiresAt, 'Retry exceeds interaction lifetime');
    this.state = 'READY';
    this.nextAttemptAt = new Date(nextAttemptAt);
    this.touch(at);
  }

  /** Cancel an unsent intent and erase interaction secrets without pretending an in-flight send was recalled. */
  cancelBeforeDispatch(reason: string, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(this.state === 'READY', 'In-flight or unknown delivery requires reconciliation');
    invariant(reason.length > 0 && reason.length <= 120, 'Cancellation requires a bounded reason');
    this.state = 'CANCELED';
    this.nextAttemptAt = null;
    this.outcomeDetails = { classification: 'definitive_failure', code: reason };
    this.tokenCiphertext = null;
    this.tokenKeyId = null;
    this.touch(at);
  }

  /** Expire only unsent work after its deadline; uncertain sends retain their unresolved outcome. */
  expire(expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(this.state === 'READY', 'An unknown send remains unknown after its deadline');
    invariant(at >= this.deadline || (this.tokenExpiresAt !== null && at >= this.tokenExpiresAt), 'Delivery has not expired');
    this.state = 'EXPIRED';
    this.nextAttemptAt = null;
    this.tokenCiphertext = null;
    this.tokenKeyId = null;
    this.touch(at);
  }

  /** Erase expired interaction credentials and make any still-unsent interaction intent ineligible. */
  purgeExpiredToken(expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(this.tokenExpiresAt !== null && at >= this.tokenExpiresAt, 'Interaction token has not expired');
    if (this.tokenCiphertext === null && this.tokenKeyId === null) return;
    this.tokenCiphertext = null;
    this.tokenKeyId = null;
    if (this.state === 'READY') { this.state = 'EXPIRED'; this.nextAttemptAt = null; }
    this.touch(at);
  }

  /** Unsent work is revoked. Unknown sends retain fingerprints and outcome evidence for recovery. */
  purgePayload(reason: string, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(reason.length > 0 && reason.length <= 120, 'A bounded purge reason is required');
    if (this.payloadPurgedAt) return;
    if (this.state === 'READY') { this.state = 'CANCELED'; this.nextAttemptAt = null; }
    this.acceptedContent = null;
    this.supportingReferences = null;
    this.allowedMentions = null;
    this.tokenCiphertext = null;
    this.tokenKeyId = null;
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reason;
    this.touch(at);
  }

  /** Map validated transport evidence to delivered, failed or unknown state and retain the attempt response time. */
  private applyOutcome(outcome: ReplyOutcome, at: Date): void {
    invariant(this.attempt !== null, 'Missing attempt');
    if (outcome.httpStatus !== undefined) invariant(Number.isInteger(outcome.httpStatus) && outcome.httpStatus >= 100 && outcome.httpStatus <= 599, 'Invalid HTTP status');
    if (outcome.classification === 'delivered') {
      assertDiscordId(outcome.messageId);
      this.discordMessageId = outcome.messageId;
      this.state = 'DELIVERED';
      this.tokenCiphertext = null;
      this.tokenKeyId = null;
    } else {
      invariant(outcome.code.length > 0 && outcome.code.length <= 120, 'Outcome requires a bounded code');
      this.state = outcome.classification === 'unknown' ? 'UNKNOWN' : 'FAILED';
    }
    this.outcomeDetails = copyJson(outcome);
    this.attempt = { ...this.attempt, respondedAt: at.toISOString(), responseClassification: outcome.classification };
    this.touch(at);
  }
  /** Require the exact state and generation before recording any attempt transition. */
  private checkAttempt(generation: number, expected: number, at: Date, state: ReplyDeliveryState): void {
    this.check(expected, at);
    invariant(this.state === state && this.generation === generation && this.attempt?.generation === generation, 'Stale delivery attempt');
  }
  /** Reject stale row revisions and backwards transition times before changing owner state. */
  private check(expected: number, at: Date): void {
    assertDate(at, 'at');
    invariant(this.rowRevision === expected, 'Stale delivery revision');
    invariant(at >= this.updatedAt, 'Transition time cannot move backwards');
  }
  /** Advance the access revision and copy the transition timestamp after a validated change. */
  private touch(at: Date): void { this.rowRevision = nextRevision(this.rowRevision); this.updatedAt = new Date(at); }
}
