import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';
import { nextRevision, validateAudience, validateContinuation, type AudienceBinding, type ContextBinding, type InteractionContinuation } from './community-values.js';

export interface ConversationRequestInput extends ScopedEntityInput {
  requestKey: string;
  source: { kind: 'message'; channelId: string; messageId: string } | { kind: 'interaction'; channelId: string; continuation: InteractionContinuation };
  sourceVersion: number;
  settingsRevision: number;
  contextBindings: ContextBinding[];
  audienceBinding: AudienceBinding;
  deadline: Date;
  purgeAfter: Date;
}
export type ConversationStage = 'created' | 'routing' | 'routed' | 'generating' | 'accepted' | 'declined' | 'canceled';
export interface ConversationCompletion {
  taskId: string;
  resultId: string;
  sourceVersion: number;
  cancellationGeneration: number;
  expectedRowRevision: number;
  at: Date;
}

/** Generation status only. Actual publication remains authoritative on ReplyDelivery. */
@Check({ name: 'conversation_request_check_1', expression: "(source_kind = 'message' AND source_message_id IS NOT NULL AND interaction_id IS NULL AND interaction_continuation IS NULL) OR (source_kind = 'interaction' AND source_message_id IS NULL AND interaction_id IS NOT NULL)" })
@Check({ name: 'conversation_request_check_2', expression: "stage IN ('created', 'routing', 'routed', 'generating', 'accepted', 'declined', 'canceled')" })
@Check({ name: 'conversation_request_check_3', expression: "(canceled_at IS NULL) = (cancellation_reason IS NULL)" })
@Check({ name: 'conversation_request_check_4', expression: "stage <> 'accepted' OR accepted_result_reference IS NOT NULL" })
@Check({ name: 'conversation_request_check_5', expression: "(payload_purged_at IS NULL AND purge_reason IS NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND context_bindings IS NULL AND interaction_continuation IS NULL)" })
@Entity({ tableName: 'conversation_request' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'requestKey'] })
export class ConversationRequest extends ScopedEntity {
  @Property({ type: 'text' }) readonly requestKey: string;
  @Property({ type: 'text' }) readonly sourceKind: 'message' | 'interaction';
  @Property({ type: 'text' }) readonly sourceChannelId: string;
  @Property({ type: 'text', nullable: true }) readonly sourceMessageId: string | null;
  @Property({ type: 'text', nullable: true }) readonly interactionId: string | null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true, hidden: true }) interactionContinuation: InteractionContinuation | null;
  @Property({ type: 'integer' }) readonly sourceVersion: number;
  @Property({ type: 'text' }) stage: ConversationStage = 'created';
  @Property({ type: 'uuid', nullable: true }) expectedTaskId: string | null = null;
  @Property({ type: 'uuid', nullable: true }) acceptedResultReference: string | null = null;
  @Property({ type: 'integer' }) readonly settingsRevision: number;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) contextBindings: ContextBinding[] | null;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly audienceBinding: AudienceBinding;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly deadline: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) canceledAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) cancellationReason: string | null = null;
  @Property({ type: 'integer' }) cancellationGeneration = 0;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  constructor(input: ConversationRequestInput) {
    super(input);
    assertDiscordId(input.source.channelId);
    for (const [label, value] of [['sourceVersion', input.sourceVersion], ['settingsRevision', input.settingsRevision]] as const) {
      assertNonNegativeInteger(value, label);
      invariant(value <= 2147483647, `${label} exceeds storage range`);
    }
    assertDate(input.deadline, 'deadline');
    assertDate(input.purgeAfter, 'purgeAfter');
    invariant(input.deadline > this.createdAt && input.purgeAfter >= input.deadline, 'Request requires a bounded deadline within context retention');
    invariant(input.requestKey.length > 0 && input.requestKey.length <= 200, 'Request key must be bounded');
    invariant(input.contextBindings.length <= 100, 'Selected context must be bounded');
    validateAudience(input.audienceBinding);
    invariant(input.audienceBinding.channelId === input.source.channelId, 'Audience must bind the selected source channel');
    this.sourceKind = input.source.kind;
    this.sourceChannelId = input.source.channelId;
    if (input.source.kind === 'message') {
      assertDiscordId(input.source.messageId);
      this.sourceMessageId = input.source.messageId;
      this.interactionId = null;
      this.interactionContinuation = null;
    } else {
      validateContinuation(input.source.continuation, this.createdAt);
      invariant(input.source.continuation.ephemeral === (input.audienceBinding.visibility === 'requester'), 'Ephemeral choice must match the authorized audience');
      this.sourceMessageId = null;
      this.interactionId = input.source.continuation.interactionId;
      this.interactionContinuation = copyJson(input.source.continuation);
    }
    this.requestKey = input.requestKey;
    this.sourceVersion = input.sourceVersion;
    this.settingsRevision = input.settingsRevision;
    this.contextBindings = copyJson(input.contextBindings);
    this.audienceBinding = copyJson(input.audienceBinding);
    this.deadline = new Date(input.deadline);
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(this.createdAt);
  }

  expectTask(taskId: string, stage: 'routing' | 'generating', expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    assertUuid(taskId);
    invariant(at < this.deadline && this.payloadPurgedAt === null, 'Request is no longer eligible');
    invariant(stage === 'routing' ? this.stage === 'created' : ['created', 'routed'].includes(this.stage), 'Incompatible generation stage');
    this.expectedTaskId = taskId;
    this.stage = stage;
    this.touch(at);
  }

  acceptRouting(input: ConversationCompletion, shouldReply: boolean): void {
    this.checkCompletion(input, 'routing');
    this.expectedTaskId = null;
    this.stage = shouldReply ? 'routed' : 'declined';
    if (!shouldReply) this.interactionContinuation = null;
    this.touch(input.at);
  }

  /** Insert ReplyDelivery with this returned continuation in the same acceptance transaction. */
  acceptReply(input: ConversationCompletion): InteractionContinuation | null {
    this.checkCompletion(input, 'generating');
    if (this.sourceKind === 'interaction') {
      invariant(this.interactionContinuation !== null, 'Interaction continuation is unavailable');
      validateContinuation(this.interactionContinuation, input.at);
    }
    const continuation = this.interactionContinuation ? copyJson(this.interactionContinuation) : null;
    this.acceptedResultReference = input.resultId;
    this.expectedTaskId = null;
    this.stage = 'accepted';
    this.interactionContinuation = null;
    this.touch(input.at);
    return continuation;
  }

  /** Cancellation does not claim that an already-dispatched reply was recalled. */
  cancel(reason: string, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(reason.length > 0 && reason.length <= 120, 'Cancellation requires a bounded reason');
    if (this.canceledAt) return;
    this.canceledAt = new Date(at);
    this.cancellationReason = reason;
    this.cancellationGeneration = nextRevision(this.cancellationGeneration);
    this.stage = 'canceled';
    this.expectedTaskId = null;
    this.interactionContinuation = null;
    this.touch(at);
  }

  purgePayload(reason: string, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(reason.length > 0 && reason.length <= 120, 'A bounded purge reason is required');
    if (this.payloadPurgedAt) return;
    if (!['accepted', 'declined', 'canceled'].includes(this.stage)) this.cancel(reason, expectedRowRevision, at);
    this.contextBindings = null;
    this.interactionContinuation = null;
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reason;
    this.touch(at);
  }

  private checkCompletion(input: ConversationCompletion, stage: ConversationStage): void {
    this.check(input.expectedRowRevision, input.at);
    assertUuid(input.resultId);
    invariant(this.stage === stage && this.expectedTaskId === input.taskId && this.cancellationGeneration === input.cancellationGeneration, 'Stale or unexpected task completion');
    invariant(this.sourceVersion === input.sourceVersion && this.canceledAt === null && input.at < this.deadline && this.payloadPurgedAt === null, 'Request is no longer eligible');
  }
  private check(expected: number, at: Date): void {
    assertDate(at, 'at');
    invariant(this.rowRevision === expected, 'Stale request revision');
    invariant(at >= this.updatedAt, 'Transition time cannot move backwards');
  }
  private touch(at: Date): void { this.rowRevision = nextRevision(this.rowRevision); this.updatedAt = new Date(at); }
}
