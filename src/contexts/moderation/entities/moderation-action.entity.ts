import { nextCounter } from './moderation-values.js';
import { createHash } from 'node:crypto';
import { Collection } from '@mikro-orm/core';
import { Check, Entity, Index, ManyToMany, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';
import { ModerationFinding } from './moderation-finding.entity.js';

export type ModerationOperation =
  | { schemaVersion: 1; kind: 'ban'; reason: string; deleteMessageSeconds: number }
  | { schemaVersion: 1; kind: 'unban'; reason: string }
  | { schemaVersion: 1; kind: 'kick'; reason: string }
  | { schemaVersion: 1; kind: 'warning'; text: string; destination: { kind: 'channel'; channelId: string } | { kind: 'direct_message' }; allowedMentions: { users: string[]; roles: string[]; everyone: false } };
export interface AdminUnbanRequest {
  schemaVersion: 1;
  source: 'yuna';
  requestId: string;
  actorUserId: string;
  targetUserId: string;
  authorizationKind: 'discord_administrator';
  authorizedAt: string;
}
export interface StaffActionAuthority {
  origin: 'staff';
  sourceRequestId: string;
  actorUserId: string;
  grantBinding: { schemaVersion: 1; grantId: string; revision: number; operationHash: string };
  caseId?: string | null;
}
/** Supplied only by the owner after verifying an explicit administrator request through Yuna. */
export interface AdminUnbanRequestAuthority extends StaffActionAuthority { adminUnbanRequest: AdminUnbanRequest }
export type ModerationAuthority =
  | { origin: 'policy'; caseId: string; evidenceRevisionId: string; policyRevisionId: string; findings: ModerationFinding[] }
  | StaffActionAuthority;
interface ModerationActionBaseInput extends ScopedEntityInput {
  targetUserId: string;
  deduplicationKey: string;
  auditCorrelation: string;
  safetyRevision: number;
  purgeAfter: Date;
}
export type ModerationActionInput = ModerationActionBaseInput & (
  | { operationPayload: Exclude<ModerationOperation, { kind: 'unban' }>; authority: ModerationAuthority }
  | { operationPayload: Extract<ModerationOperation, { kind: 'unban' }>; authority: AdminUnbanRequestAuthority }
);
export function hashModerationOperation(targetUserId: string, operation: ModerationOperation): string {
  return createHash('sha256').update(JSON.stringify({ targetUserId, operation })).digest('hex');
}
export type ModerationActionState = 'READY' | 'DISPATCHED' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED' | 'CANCELED';
export interface ModerationOutcome {
  classification: 'confirmed' | 'definitive_failure' | 'unknown';
  code: string;
  httpStatus?: number;
  discordMessageId?: string;
  discordAuditEntryId?: string;
}
export interface ActionDispatchClaim {
  attemptId: string;
  expectedGeneration: number;
  expectedRowRevision: number;
  safetyRevision: number;
  evidenceAvailable: boolean;
  at: Date;
}

/** Exact durable intent. Persist it, its evidence links and the attempt before issuing Discord I/O. */
@Check({ name: 'moderation_action_check_1', expression: "kind IN ('ban', 'unban', 'warning', 'kick') AND state IN ('READY', 'DISPATCHED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'CANCELED')" })
@Check({ name: 'moderation_action_check_2', expression: "(origin = 'policy' AND case_id IS NOT NULL AND evidence_revision_id IS NOT NULL AND policy_revision_id IS NOT NULL AND source_request_id IS NULL AND actor_user_id IS NULL AND grant_binding IS NULL) OR (origin = 'staff' AND source_request_id IS NOT NULL AND actor_user_id IS NOT NULL AND grant_binding IS NOT NULL AND evidence_revision_id IS NULL AND policy_revision_id IS NULL)" })
@Check({ name: 'moderation_action_check_3', expression: "kind <> 'unban' OR (origin = 'staff' AND admin_unban_request IS NOT NULL AND admin_unban_request->>'source' = 'yuna' AND admin_unban_request->>'authorizationKind' = 'discord_administrator' AND admin_unban_request->>'requestId' = source_request_id AND admin_unban_request->>'actorUserId' = actor_user_id AND admin_unban_request->>'targetUserId' = target_user_id) IS TRUE" })
@Check({ name: 'moderation_action_check_4', expression: "operation_payload IS NULL OR (operation_payload->>'kind' = kind AND operation_payload->>'schemaVersion' = '1') IS TRUE" })
@Check({ name: 'moderation_action_check_5', expression: "grant_binding IS NULL OR (grant_binding->>'operationHash' = payload_hash) IS TRUE" })
@Check({ name: 'moderation_action_check_6', expression: "(payload_purged_at IS NULL AND purge_reason IS NULL AND operation_payload IS NOT NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND operation_payload IS NULL)" })
@Check({ name: 'moderation_action_check_7', expression: "state <> 'READY' OR operation_payload IS NOT NULL" })
@Check({ name: 'moderation_action_check_8', expression: "state NOT IN ('DISPATCHED', 'UNKNOWN', 'CONFIRMED') OR active_attempt_id IS NOT NULL" })
@Check({ name: 'moderation_action_check_9', expression: "execution_generation >= 0 AND row_revision > 0" })
@Entity({ tableName: 'moderation_action' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'deduplicationKey'] })
@Index({ properties: ['state', 'nextAttemptAt'] })
export class ModerationAction extends ScopedEntity {
  @Property({ type: 'text' }) readonly kind: ModerationOperation['kind'];
  @Property({ type: 'text' }) readonly targetUserId: string;
  @Property({ type: 'text' }) readonly origin: ModerationAuthority['origin'];
  @Property({ type: 'text', nullable: true }) readonly sourceRequestId: string | null;
  @Property({ type: 'text', nullable: true }) readonly actorUserId: string | null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) readonly grantBinding: Extract<ModerationAuthority, { origin: 'staff' }>['grantBinding'] | null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) readonly adminUnbanRequest: AdminUnbanRequest | null;
  @Property({ type: 'uuid', nullable: true }) readonly caseId: string | null;
  @Property({ type: 'uuid', nullable: true }) readonly evidenceRevisionId: string | null;
  @Property({ type: 'uuid', nullable: true }) readonly policyRevisionId: string | null;
  @ManyToMany(() => ModerationFinding, undefined, { pivotTable: 'moderation_action_finding', joinColumn: 'action_id', inverseJoinColumn: 'finding_id' })
  readonly findings = new Collection<ModerationFinding>(this);
  @Property({ type: 'text' }) readonly deduplicationKey: string;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) operationPayload: ModerationOperation | null;
  @Property({ type: 'text' }) readonly payloadHash: string;
  @Property({ type: 'text' }) readonly auditCorrelation: string;
  @Property({ type: 'integer' }) readonly safetyRevision: number;
  @Property({ type: 'text' }) state: ModerationActionState = 'READY';
  @Property({ type: 'integer' }) executionGeneration = 0;
  @Property({ type: 'uuid', nullable: true }) activeAttemptId: string | null = null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) nextAttemptAt: Date | null = null;
  @Property({ type: 'json', columnType: 'jsonb', nullable: true }) outcomeSummary: ModerationOutcome | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  constructor(input: ModerationActionInput) {
    super(input);
    assertDiscordId(input.targetUserId);
    assertNonNegativeInteger(input.safetyRevision, 'safetyRevision');
    assertDate(input.purgeAfter, 'purgeAfter');
    invariant(input.purgeAfter > this.createdAt, 'Action payload must be retained after creation');
    invariant(input.deduplicationKey.length > 0 && input.deduplicationKey.length <= 200, 'Action requires a bounded deduplication key');
    invariant(input.auditCorrelation.length > 0 && input.auditCorrelation.length <= 100, 'Action requires a bounded audit correlation');
    const operation = input.operationPayload;
    invariant(operation.schemaVersion === 1, 'Unsupported operation schema');
    if (operation.kind === 'ban') {
      assertNonNegativeInteger(operation.deleteMessageSeconds, 'deleteMessageSeconds');
      invariant(operation.deleteMessageSeconds <= 604800, 'Ban history deletion exceeds the endpoint limit');
    }
    if (operation.kind === 'warning') {
      invariant(operation.text.length > 0 && operation.text.length <= 2000, 'Warning must fit one Discord message');
      if (operation.destination.kind === 'channel') assertDiscordId(operation.destination.channelId);
      for (const value of [...operation.allowedMentions.users, ...operation.allowedMentions.roles]) assertDiscordId(value);
      invariant(operation.allowedMentions.everyone === false, 'Warnings cannot mention everyone');
    } else invariant(operation.reason.length > 0 && operation.reason.length <= 512, 'Operation reason must be bounded');
    const authority = input.authority;
    this.origin = authority.origin;
    this.adminUnbanRequest = null;
    if (operation.kind === 'unban') {
      invariant(authority.origin === 'staff' && 'adminUnbanRequest' in authority, 'Unban requires an explicit administrator request through Yuna');
      const request = authority.adminUnbanRequest as AdminUnbanRequest;
      invariant(request.schemaVersion === 1 && request.source === 'yuna' && request.authorizationKind === 'discord_administrator', 'Unban requires verified administrator request provenance');
      invariant(request.requestId === authority.sourceRequestId && request.actorUserId === authority.actorUserId && request.targetUserId === input.targetUserId, 'Administrator unban request must bind this exact actor, target and request');
      assertDate(new Date(request.authorizedAt), 'authorizedAt');
      invariant(new Date(request.authorizedAt) <= this.createdAt, 'Administrator authorization cannot be from the future');
      this.adminUnbanRequest = copyJson(request);
    }
    this.caseId = authority.caseId ?? null;
    if (this.caseId) assertUuid(this.caseId);
    if (authority.origin === 'policy') {
      assertUuid(authority.evidenceRevisionId);
      assertUuid(authority.policyRevisionId);
      invariant(authority.findings.length > 0 && authority.findings.length <= 100, 'Policy action requires contributing findings');
      invariant(operation.kind !== 'unban', 'Unban requires an explicit administrator request through Yuna');
      for (const finding of authority.findings) {
        invariant(finding.installationId === this.installationId && finding.guildId === this.guildId && finding.caseId === authority.caseId, 'Contributing finding belongs to another case or tenant');
        invariant(finding.evidenceRevisionId === authority.evidenceRevisionId && finding.policyRevisionId === authority.policyRevisionId, 'Contributing finding uses different evidence or policy');
        invariant(finding.payloadPurgedAt === null && finding.purgeAfter >= input.purgeAfter, 'Accepted explanation must remain available for the action review period');
        invariant(finding.disposition === 'violation' || (operation.kind === 'warning' && finding.disposition === 'suspicion'), 'Finding does not support this operation');
      }
      this.findings.add(authority.findings);
      this.evidenceRevisionId = authority.evidenceRevisionId;
      this.policyRevisionId = authority.policyRevisionId;
      this.sourceRequestId = null;
      this.actorUserId = null;
      this.grantBinding = null;
    } else {
      assertDiscordId(authority.actorUserId);
      assertUuid(authority.grantBinding.grantId);
      assertNonNegativeInteger(authority.grantBinding.revision, 'grant revision');
      invariant(authority.sourceRequestId.length > 0, 'Staff action requires authenticated request provenance');
      this.sourceRequestId = authority.sourceRequestId;
      this.actorUserId = authority.actorUserId;
      this.grantBinding = copyJson(authority.grantBinding);
      this.evidenceRevisionId = null;
      this.policyRevisionId = null;
    }
    this.kind = operation.kind;
    this.targetUserId = input.targetUserId;
    this.deduplicationKey = input.deduplicationKey;
    this.operationPayload = copyJson(operation);
    this.payloadHash = hashModerationOperation(this.targetUserId, operation);
    invariant(this.grantBinding === null || this.grantBinding.operationHash === this.payloadHash, 'Staff authority must bind the exact target and operation');
    this.auditCorrelation = input.auditCorrelation;
    this.safetyRevision = input.safetyRevision;
    this.purgeAfter = new Date(input.purgeAfter);
    this.updatedAt = new Date(this.createdAt);
  }

  claimDispatch(input: ActionDispatchClaim): number {
    this.check(input.expectedRowRevision, input.at);
    assertUuid(input.attemptId);
    invariant(this.state === 'READY' && this.executionGeneration === input.expectedGeneration, 'Action is not ready for this generation');
    invariant(this.safetyRevision === input.safetyRevision, 'Safety binding changed');
    invariant(this.operationPayload !== null && this.purgeAfter > input.at, 'Action payload is unavailable');
    invariant(this.origin !== 'policy' || input.evidenceAvailable, 'Bound original evidence must remain available');
    invariant(this.nextAttemptAt === null || this.nextAttemptAt <= input.at, 'Retry is not due');
    this.executionGeneration = nextCounter(this.executionGeneration);
    this.activeAttemptId = input.attemptId;
    this.state = 'DISPATCHED';
    this.nextAttemptAt = null;
    this.touch(input.at);
    return this.executionGeneration;
  }

  recordOutcome(attemptId: string, generation: number, outcome: ModerationOutcome, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(this.activeAttemptId === attemptId && this.executionGeneration === generation && this.state === 'DISPATCHED', 'Stale dispatch outcome');
    this.applyOutcome(outcome, at);
  }

  /** Only attributable evidence can resolve an ambiguous send; current target state is insufficient. */
  recordReconciliation(attemptId: string, generation: number, outcome: ModerationOutcome, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(this.activeAttemptId === attemptId && this.executionGeneration === generation && this.state === 'UNKNOWN', 'Stale reconciliation');
    this.applyOutcome(outcome, at);
  }

  scheduleRetry(at: Date, expectedRowRevision: number, now: Date): void {
    this.check(expectedRowRevision, now);
    assertDate(at, 'nextAttemptAt');
    invariant(this.state === 'FAILED' && this.outcomeSummary?.classification === 'definitive_failure', 'Only a definitive non-effect can be retried');
    invariant(at >= now && at < this.purgeAfter && this.operationPayload !== null, 'Retry must fit retained payload lifetime');
    this.state = 'READY';
    this.activeAttemptId = null;
    this.nextAttemptAt = new Date(at);
    this.touch(now);
  }

  cancelBeforeDispatch(reason: string, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(this.state === 'READY', 'An in-flight or unknown action cannot be canceled');
    invariant(reason.length > 0 && reason.length <= 120, 'Cancellation requires a bounded reason');
    this.state = 'CANCELED';
    this.nextAttemptAt = null;
    this.outcomeSummary = { classification: 'definitive_failure', code: reason };
    this.touch(at);
  }

  purgePayload(at: Date, reason: string, expectedRowRevision: number): void {
    this.check(expectedRowRevision, at);
    invariant(reason.length > 0 && reason.length <= 120, 'A bounded purge reason is required');
    if (this.payloadPurgedAt) return;
    if (this.state === 'READY') { this.state = 'CANCELED'; this.nextAttemptAt = null; }
    this.operationPayload = null;
    this.payloadPurgedAt = new Date(at);
    this.purgeReason = reason;
    this.touch(at);
  }

  private applyOutcome(outcome: ModerationOutcome, at: Date): void {
    invariant(outcome.code.length > 0 && outcome.code.length <= 120, 'Outcome requires a bounded code');
    if (outcome.discordMessageId) assertDiscordId(outcome.discordMessageId);
    if (outcome.discordAuditEntryId) assertDiscordId(outcome.discordAuditEntryId);
    this.state = outcome.classification === 'confirmed' ? 'CONFIRMED' : outcome.classification === 'unknown' ? 'UNKNOWN' : 'FAILED';
    this.outcomeSummary = copyJson(outcome);
    this.touch(at);
  }
  private check(expected: number, at: Date): void {
    assertDate(at, 'at');
    invariant(this.rowRevision === expected, 'Stale action revision');
    invariant(at >= this.updatedAt, 'Transition time cannot move backwards');
  }
  private touch(at: Date): void { this.rowRevision = nextCounter(this.rowRevision); this.updatedAt = new Date(at); }
}
