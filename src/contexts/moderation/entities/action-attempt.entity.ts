import { nextCounter } from './moderation-values.js';
import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface ActionAttemptInput extends ScopedEntityInput {
  actionId: string;
  attemptNumber: number;
  dispatchGeneration: number;
  executorId: string;
  leaseUntil: Date | null;
  claimedAt: Date;
  endpoint: 'create_guild_ban' | 'remove_guild_ban' | 'remove_guild_member' | 'create_message';
  destination: { guildId: string; targetUserId?: string; channelId?: string };
  requestFingerprint: string;
  requestNonce?: string | null;
}
export interface ActionResponse {
  responseClass: 'success' | 'definitive_failure' | 'unknown';
  httpStatus: number | null;
  discordErrorCode?: string | null;
  discordMessageId?: string | null;
  discordAuditEntryId?: string | null;
  providerRequestReference?: string | null;
  retryAfterAt?: Date | null;
}
export interface ActionReconciliationEvidence {
  observedAt: string;
  classification: 'attributable_success' | 'definitively_not_applied' | 'inconclusive';
  source: 'http_response' | 'discord_audit_log' | 'message_lookup';
  reference: string;
}

/** One dispatch opportunity. No timestamp or expired lease proves that the request was never sent. */
@Check({ name: 'action_attempt_check_1', expression: "attempt_number > 0 AND dispatch_generation > 0 AND row_revision > 0" })
@Check({ name: 'action_attempt_check_2', expression: "http_status IS NULL OR http_status BETWEEN 100 AND 599" })
@Check({ name: 'action_attempt_check_3', expression: "(finished_at IS NULL) = (response_class IS NULL)" })
@Check({ name: 'action_attempt_check_4', expression: "request_nonce IS NULL OR (endpoint = 'create_message' AND length(request_nonce) BETWEEN 1 AND 25)" })
@Entity({ tableName: 'action_attempt' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'actionId', 'attemptNumber'] })
export class ActionAttempt extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly actionId: string;
  @Property({ type: 'integer' }) readonly attemptNumber: number;
  @Property({ type: 'integer' }) readonly dispatchGeneration: number;
  @Property({ type: 'text' }) readonly executorId: string;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly leaseUntil: Date | null;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly claimedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) sentAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) finishedAt: Date | null = null;
  @Property({ type: 'text' }) readonly endpoint: ActionAttemptInput['endpoint'];
  @Property({ type: 'json', columnType: 'jsonb' }) readonly destination: ActionAttemptInput['destination'];
  @Property({ type: 'text' }) readonly requestFingerprint: string;
  @Property({ type: 'text', nullable: true }) readonly requestNonce: string | null;
  @Property({ type: 'integer', nullable: true }) httpStatus: number | null = null;
  @Property({ type: 'text', nullable: true }) discordErrorCode: string | null = null;
  @Property({ type: 'text', nullable: true }) responseClass: ActionResponse['responseClass'] | null = null;
  @Property({ type: 'text', nullable: true }) discordMessageId: string | null = null;
  @Property({ type: 'text', nullable: true }) discordAuditEntryId: string | null = null;
  @Property({ type: 'text', nullable: true }) providerRequestReference: string | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) retryAfterAt: Date | null = null;
  @Property({ type: 'json', columnType: 'jsonb' }) reconciliationEvidence: ActionReconciliationEvidence[] = [];
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;

  constructor(input: ActionAttemptInput) {
    super(input);
    assertUuid(input.actionId);
    assertNonNegativeInteger(input.attemptNumber, 'attemptNumber');
    assertNonNegativeInteger(input.dispatchGeneration, 'dispatchGeneration');
    invariant(input.attemptNumber > 0 && input.dispatchGeneration > 0, 'Attempt and generation start at one');
    assertDate(input.claimedAt, 'claimedAt');
    if (input.leaseUntil) { assertDate(input.leaseUntil, 'leaseUntil'); invariant(input.leaseUntil > input.claimedAt, 'Lease must follow claim'); }
    invariant(input.executorId.length > 0 && input.executorId.length <= 200, 'Executor identity must be bounded');
    invariant(/^[a-f0-9]{64}$/.test(input.requestFingerprint), 'Request fingerprint must be SHA-256');
    invariant(input.destination.guildId === input.guildId, 'Attempt destination must match its guild');
    if (input.destination.targetUserId) assertDiscordId(input.destination.targetUserId);
    if (input.destination.channelId) assertDiscordId(input.destination.channelId);
    invariant(input.endpoint === 'create_message' ? !!input.destination.channelId : !!input.destination.targetUserId, 'Endpoint requires its exact destination');
    invariant(input.requestNonce == null || (input.endpoint === 'create_message' && input.requestNonce.length > 0 && input.requestNonce.length <= 25), 'Only message sends have a nonce of at most 25 characters');
    this.actionId = input.actionId;
    this.attemptNumber = input.attemptNumber;
    this.dispatchGeneration = input.dispatchGeneration;
    this.executorId = input.executorId;
    this.leaseUntil = input.leaseUntil ? new Date(input.leaseUntil) : null;
    this.claimedAt = new Date(input.claimedAt);
    this.endpoint = input.endpoint;
    this.destination = copyJson(input.destination);
    this.requestFingerprint = input.requestFingerprint;
    this.requestNonce = input.requestNonce ?? null;
  }

  markSent(generation: number, at: Date): void {
    this.check(generation, at);
    invariant(this.finishedAt === null, 'Completed attempts cannot be sent again');
    if (this.sentAt) return;
    this.sentAt = new Date(at);
    this.rowRevision = nextCounter(this.rowRevision);
  }

  recordResponse(generation: number, response: ActionResponse, at: Date): void {
    this.check(generation, at);
    invariant(this.finishedAt === null, 'Record later observations as reconciliation evidence');
    if (response.httpStatus !== null) invariant(Number.isInteger(response.httpStatus) && response.httpStatus >= 100 && response.httpStatus <= 599, 'Invalid HTTP status');
    if (response.discordMessageId) assertDiscordId(response.discordMessageId);
    if (response.discordAuditEntryId) assertDiscordId(response.discordAuditEntryId);
    if (response.retryAfterAt) assertDate(response.retryAfterAt, 'retryAfterAt');
    if (response.responseClass === 'success') invariant(response.httpStatus !== null && response.httpStatus >= 200 && response.httpStatus < 300, 'Observed HTTP success requires a successful response');
    this.responseClass = response.responseClass;
    this.httpStatus = response.httpStatus;
    this.discordErrorCode = response.discordErrorCode ?? null;
    this.discordMessageId = response.discordMessageId ?? null;
    this.discordAuditEntryId = response.discordAuditEntryId ?? null;
    this.providerRequestReference = response.providerRequestReference ?? null;
    this.retryAfterAt = response.retryAfterAt ? new Date(response.retryAfterAt) : null;
    this.finishedAt = new Date(at);
    this.rowRevision = nextCounter(this.rowRevision);
  }

  /** Late evidence is useful even after authority has moved; it never grants permission to dispatch. */
  recordReconciliation(evidence: ActionReconciliationEvidence): void {
    assertDate(new Date(evidence.observedAt), 'observedAt');
    invariant(evidence.reference.length > 0 && evidence.reference.length <= 200, 'Reconciliation requires bounded attributable provenance');
    const key = JSON.stringify(evidence);
    if (this.reconciliationEvidence.some((entry) => JSON.stringify(entry) === key)) return;
    invariant(this.reconciliationEvidence.length < 20, 'Reconciliation history reached its bound');
    this.reconciliationEvidence = [...this.reconciliationEvidence, copyJson(evidence)];
    this.rowRevision = nextCounter(this.rowRevision);
  }

  private check(generation: number, at: Date): void {
    assertDate(at, 'at');
    invariant(generation === this.dispatchGeneration, 'Stale attempt generation');
    invariant(at >= this.claimedAt && (this.sentAt === null || at >= this.sentAt), 'Attempt observations cannot precede known dispatch facts');
  }
}
