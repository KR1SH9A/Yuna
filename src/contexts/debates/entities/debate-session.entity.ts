import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export type DebateState = 'proposed' | 'active' | 'frozen' | 'evaluating' | 'evaluated' | 'canceled';
export type EvaluationVariant = 'original' | 'reversed';
export interface DebateConsentScope {
  schemaVersion: 1;
  purpose: 'debate_evaluation';
  audienceChannelId: string;
  retentionSeconds: number;
  includeEdits: boolean;
  includeDeletedContent: boolean;
}
export interface DebateSessionInput extends ScopedEntityInput {
  sourceRequestId: string;
  sourceOperationKey: string;
  channelId: string;
  topic: string;
  invitedUserIds: readonly string[];
  scopeRevision: number;
  consentScope: DebateConsentScope;
  rubricRevisionId: string;
  purgeAfter: Date;
}

/** Staged session: invited users are never treated as consented participants. */
@Entity({ tableName: 'debate_session' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'sourceRequestId', 'sourceOperationKey'] })
@Check({ name: 'debate_session_check_1', expression: `"state" in ('proposed', 'active', 'frozen', 'evaluating', 'evaluated', 'canceled')` })
@Check({ name: 'debate_session_check_2', expression: `"state" not in ('frozen', 'evaluating', 'evaluated') or "frozen_transcript_id" is not null` })
@Check({ name: 'debate_session_check_3', expression: `"state" <> 'evaluated' or "accepted_evaluation_id" is not null` })
@Check({ name: 'debate_session_check_4', expression: '"row_revision" >= 1' })
export class DebateSession extends ScopedEntity {
  @Property({ type: 'text' }) readonly sourceRequestId: string;
  @Property({ type: 'text' }) readonly sourceOperationKey: string;
  @Property({ type: 'text' }) readonly channelId: string;
  @Property({ type: 'text', nullable: true }) topic: string | null;
  @Property({ type: 'json' }) readonly invitedUserIds: readonly string[];
  @Property({ type: 'integer' }) readonly scopeRevision: number;
  @Property({ type: 'json' }) readonly consentScope: DebateConsentScope;
  @Property({ type: 'text' }) state: DebateState = 'proposed';
  @Property({ type: 'uuid' }) readonly rubricRevisionId: string;
  @Property({ type: 'uuid', nullable: true }) frozenTranscriptId: string | null = null;
  @Property({ type: 'json' }) expectedEvaluationTasks: Partial<Record<EvaluationVariant, string>> = {};
  @Property({ type: 'uuid', nullable: true }) acceptedEvaluationId: string | null = null;
  @Property({ type: 'integer' }) cancellationGeneration = 0;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) startedAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) frozenAt: Date | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) canceledAt: Date | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  constructor(input: DebateSessionInput) {
    super(input);
    assertDiscordId(input.channelId);
    assertUuid(input.rubricRevisionId);
    assertNonNegativeInteger(input.scopeRevision, 'scopeRevision');
    invariant(input.scopeRevision <= 2_147_483_647, 'scopeRevision exceeds the database integer range');
    assertDate(input.purgeAfter, 'purgeAfter');
    input.invitedUserIds.forEach(assertDiscordId);
    invariant(input.invitedUserIds.length > 0 && new Set(input.invitedUserIds).size === input.invitedUserIds.length, 'Invite distinct participants');
    invariant(input.topic.length > 0 && input.sourceRequestId.length > 0 && input.sourceOperationKey.length > 0, 'Session content and request identity are required');
    assertDiscordId(input.consentScope.audienceChannelId);
    assertNonNegativeInteger(input.consentScope.retentionSeconds, 'retentionSeconds');
    invariant(input.consentScope.schemaVersion === 1 && input.consentScope.retentionSeconds > 0, 'Invalid consent scope');
    invariant(input.purgeAfter > this.createdAt, 'Session retention has already expired');
    this.sourceRequestId = input.sourceRequestId;
    this.sourceOperationKey = input.sourceOperationKey;
    this.channelId = input.channelId;
    this.topic = input.topic;
    this.invitedUserIds = [...input.invitedUserIds];
    this.scopeRevision = input.scopeRevision;
    this.consentScope = copyJson(input.consentScope);
    this.rubricRevisionId = input.rubricRevisionId;
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(this.createdAt);
  }

  /** Supplied IDs must come from currently valid ParticipantConsent rows for this scope. */
  start(consentedUserIds: readonly string[], scopeRevision: number, at: Date): void {
    invariant(this.state === 'proposed' && scopeRevision === this.scopeRevision, 'Session or consent scope is stale');
    invariant(this.invitedUserIds.every(id => consentedUserIds.includes(id)), 'Every invited participant must consent');
    this.assertMutable(at);
    this.state = 'active';
    this.startedAt = new Date(at);
    this.touch(at);
  }

  freeze(transcriptId: string, at: Date): void {
    invariant(this.state === 'active', 'Only an active session can freeze');
    assertUuid(transcriptId);
    this.assertMutable(at);
    this.frozenTranscriptId = transcriptId;
    this.frozenAt = new Date(at);
    this.state = 'frozen';
    this.touch(at);
  }

  expectEvaluationTasks(tasks: Partial<Record<EvaluationVariant, string>>, at: Date): void {
    invariant(this.state === 'frozen', 'Freeze the transcript before registering evaluation');
    invariant(!!tasks.original && Object.values(tasks).length === new Set(Object.values(tasks)).size, 'Evaluation requires distinct expected tasks');
    Object.values(tasks).forEach(assertUuid);
    this.assertMutable(at);
    this.expectedEvaluationTasks = copyJson(tasks);
    this.state = 'evaluating';
    this.touch(at);
  }

  acceptEvaluation(input: { evaluationId: string; transcriptId: string; rubricRevisionId: string; completedTaskIds: readonly string[]; at: Date }): void {
    invariant(this.state === 'evaluating', 'Session does not expect an evaluation');
    assertUuid(input.evaluationId);
    invariant(input.transcriptId === this.frozenTranscriptId && input.rubricRevisionId === this.rubricRevisionId, 'Evaluation bindings changed');
    invariant(Object.values(this.expectedEvaluationTasks).every(taskId => input.completedTaskIds.includes(taskId)), 'Required task variants are missing');
    this.assertMutable(input.at);
    this.acceptedEvaluationId = input.evaluationId;
    this.state = 'evaluated';
    this.touch(input.at);
  }

  cancel(at: Date): void {
    if (this.state === 'canceled') return;
    assertDate(at, 'at');
    invariant(this.rowRevision < 2_147_483_647 && this.cancellationGeneration < 2_147_483_647, 'Revision exhausted');
    this.state = 'canceled';
    this.canceledAt = new Date(at);
    this.cancellationGeneration += 1;
    this.touch(at);
  }

  purgePayload(reasonCode: string, at: Date): void {
    invariant(this.state === 'canceled' || this.state === 'evaluated', 'Invalidate pending evaluation before purging');
    assertDate(at, 'at');
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded purge reason is required');
    if (this.payloadPurgedAt) return;
    invariant(this.rowRevision < 2_147_483_647, 'Revision exhausted');
    this.topic = null;
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reasonCode;
    this.touch(at);
  }

  private assertMutable(at: Date): void {
    assertDate(at, 'at');
    invariant(!this.payloadPurgedAt && at < this.purgeAfter, 'Session payload is unavailable');
    invariant(this.rowRevision < 2_147_483_647, 'Revision exhausted');
  }

  private touch(at: Date): void { this.rowRevision += 1; this.updatedAt = new Date(at); }
}
