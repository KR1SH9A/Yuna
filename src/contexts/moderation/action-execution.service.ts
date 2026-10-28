/** Own durable moderation dispatch: one recorded opportunity, current authority, and attributable recovery only. */
import { randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { assertUuid, copyJson, invariant } from '../../platform/db/entity-values.js';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { AuthorityService } from '../administration/authority.service.js';
import { SafetyService } from '../administration/safety.service.js';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import type { CurrentNativeFacts } from '../administration/contracts.js';
import { hashDiscordModerationRequest, type DiscordModerationTransport, type DiscordModerationRequest,
  type DiscordModerationPreparation, type DiscordModerationOutcome, type DiscordModerationReconciliation } from '../../discord/moderation-transport.js';
import { ModerationAction, hashModerationOperation } from './entities/moderation-action.entity.js';
import { ActionAttempt } from './entities/action-attempt.entity.js';
import { TargetExecutionState } from './entities/target-execution-state.entity.js';
import { ModerationPolicyRevision } from './entities/moderation-policy-revision.entity.js';
import { ModerationCase } from './entities/moderation-case.entity.js';
import { EvidenceRevision } from './entities/evidence-revision.entity.js';
import type { ModerationActionOutcomeDto, ModerationRecoveryResultDto } from './dto/action-outcome.dto.js';

type EffectTransport = Pick<DiscordModerationTransport, 'prepare' | 'execute' | 'reconcile'>;
export class ActionExecutionService {
  private readonly active = new Set<string>();
  private readyAfter: string | null = null;
  private reconciliationAfter: string | null = null;
  /** The same target gate covers staff and policy actions, including actions from an older installation. */
  constructor(private readonly orm: MikroORM, private readonly scope: InstallationScope,
    private readonly authority: AuthorityService, private readonly safety: SafetyService,
    private readonly administration: GuildLifecycleService, private readonly transport: EffectTransport,
    private readonly audit = new AuditRecorder()) {}

  /** Current remote facts precede a short atomic claim; committing that claim consumes the only dispatch opportunity. */
  async dispatch(actionId: string, signal: AbortSignal): Promise<ModerationActionOutcomeDto | null> {
    invariant(!this.orm.em.isInTransaction(), 'Effect orchestration must begin outside a transaction'); assertUuid(actionId);
    if (this.active.has(actionId) || signal.aborted) return null;
    this.active.add(actionId);
    try {
      const initial = await this.orm.em.fork().findOne(ModerationAction, { ...this.scope, id: actionId });
      if (!initial) return null;
      if (initial.state !== 'READY') return this.view(initial);
      if (!initial.operationPayload) return this.cancel(actionId, 'unsupported_or_missing_payload');
      if (initial.kind === 'kick' && initial.origin !== 'staff') return this.cancel(actionId, 'explicit_staff_kick_required');
      const operation = copyJson(initial.operationPayload);
      let prepared: DiscordModerationPreparation, facts: CurrentNativeFacts | null;
      try {
        [prepared, facts] = await Promise.all([this.transport.prepare({ actionId, guildId: this.scope.guildId,
          targetUserId: initial.targetUserId, operation }, signal), initial.origin === 'staff'
          ? this.authority.readCurrentFacts(this.caller(initial), this.staffOperation(initial)) : Promise.resolve(null)]);
      } catch { return this.view(initial); }
      const request = await this.orm.em.fork().transactional(async em => {
        const gate = await this.safety.lockAndReadGate(em, this.scope);
        const action = await em.findOneOrFail(ModerationAction, { ...this.scope, id: actionId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (action.state !== 'READY') return null;
        const now = new Date();
        let rejected: string | null = null;
        if (!gate?.installationActive || gate.paused || gate.safetyRevision !== action.safetyRevision) rejected = 'safety_changed';
        else if (!action.operationPayload || action.purgeAfter <= now || action.payloadPurgedAt) rejected = 'payload_expired';
        else if (action.executionGeneration !== 0 || action.payloadHash !== hashModerationOperation(action.targetUserId, action.operationPayload)) rejected = 'dispatch_already_consumed';
        else if (action.origin === 'staff') {
          if (!facts) rejected = 'native_facts_unavailable';
          else {
            const decision = await this.authority.authorizeInTransaction(em, this.caller(action), this.staffOperation(action), facts);
            if (!decision.allowed || decision.authority.grantId !== action.grantBinding?.grantId
              || decision.authority.grantRevision !== action.grantBinding.revision) rejected = 'staff_authority_changed';
          }
        } else if (!await this.policyAvailable(em, action, now)) rejected = 'policy_evidence_unavailable';
        if (rejected) { action.cancelBeforeDispatch(rejected, action.rowRevision, now); await this.auditState(em, action, now); return null; }
        if (signal.aborted || !prepared.complete || prepared.actionId !== action.id || prepared.guildId !== action.guildId
          || prepared.targetUserId !== action.targetUserId || prepared.kind !== action.kind || !(prepared.observedAt instanceof Date)
          || !Number.isFinite(prepared.observedAt.getTime()) || prepared.observedAt > now || now.getTime() - prepared.observedAt.getTime() > 5000) return null;
        if (!prepared.permitted) { action.cancelBeforeDispatch('bot_permission_denied', action.rowRevision, now); await this.auditState(em, action, now); return null; }
        if (action.nextAttemptAt && action.nextAttemptAt > now) return null;
        if (operation.kind === 'warning' && (!prepared.channelId || (operation.destination.kind === 'channel'
          && operation.destination.channelId !== prepared.channelId))) return null;
        await em.execute('insert into target_execution_state (guild_id,target_user_id,generation,row_revision,updated_at) values (?,?,0,1,?) on conflict do nothing',
          [action.guildId, action.targetUserId, now]);
        const target = await em.findOneOrFail(TargetExecutionState, { guildId: action.guildId, targetUserId: action.targetUserId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (target.unresolvedActionId) return null;
        const attemptId = randomUUID(), nonce = operation.kind === 'warning' ? BigInt(`0x${attemptId.replaceAll('-', '').slice(0, 16)}`).toString() : null;
        const exact = { actionId, attemptId, guildId: action.guildId, targetUserId: action.targetUserId, operation,
          channelId: operation.kind === 'warning' ? prepared.channelId : null, nonce, claimedAt: now };
        const request: DiscordModerationRequest = { ...exact, requestFingerprint: hashDiscordModerationRequest(exact) };
        target.claim(action.id, action.installationId, target.generation, now);
        const generation = action.claimDispatch({ attemptId, expectedGeneration: 0, expectedRowRevision: action.rowRevision,
          safetyRevision: gate!.safetyRevision, evidenceAvailable: true, at: now });
        const attempt = new ActionAttempt({ ...this.scope, id: attemptId, createdAt: now, actionId, attemptNumber: 1,
          dispatchGeneration: generation, executorId: 'bot-moderation', leaseUntil: new Date(now.getTime() + 30_000), claimedAt: now,
          endpoint: operation.kind === 'ban' ? 'create_guild_ban' : operation.kind === 'unban' ? 'remove_guild_ban'
            : operation.kind === 'kick' ? 'remove_guild_member' : 'create_message',
          destination: { guildId: action.guildId, targetUserId: action.targetUserId, ...(request.channelId ? { channelId: request.channelId } : {}) },
          requestFingerprint: request.requestFingerprint, requestNonce: nonce });
        attempt.markSent(generation, now); em.persist(attempt); await this.auditState(em, action, now);
        return request;
      });
      if (!request) return this.readOutcome(actionId);
      let outcome: DiscordModerationOutcome;
      try { outcome = await this.transport.execute(request, signal); }
      catch { outcome = { classification: 'unknown', code: 'transport_interrupted' }; }
      return this.recordOutcome(actionId, request.attemptId, outcome);
    } finally { this.active.delete(actionId); }
  }

  /** An expired lease means uncertainty; only exact Discord evidence may release its target gate. */
  async reconcile(actionId: string, signal: AbortSignal): Promise<ModerationActionOutcomeDto | null> {
    invariant(!this.orm.em.isInTransaction(), 'Effect orchestration must begin outside a transaction');
    assertUuid(actionId); if (this.active.has(actionId) || signal.aborted) return null;
    const snapshot = await this.orm.em.fork().findOne(ModerationAction, { ...this.scope, id: actionId });
    if (!snapshot || !['DISPATCHED', 'UNKNOWN'].includes(snapshot.state) || !snapshot.activeAttemptId) return snapshot ? this.view(snapshot) : null;
    const attempt = await this.orm.em.fork().findOneOrFail(ActionAttempt, { ...this.scope, id: snapshot.activeAttemptId });
    if (snapshot.state === 'DISPATCHED') {
      if (!attempt.leaseUntil || attempt.leaseUntil > new Date()) return this.view(snapshot);
      await this.recordOutcome(actionId, attempt.id, { classification: 'unknown', code: 'dispatch_outcome_unobserved' });
    }
    if (!snapshot.operationPayload || snapshot.payloadPurgedAt || snapshot.purgeAfter <= new Date()) return this.readOutcome(actionId);
    const request: DiscordModerationRequest = { actionId, attemptId: attempt.id, guildId: snapshot.guildId, targetUserId: snapshot.targetUserId,
      operation: copyJson(snapshot.operationPayload), channelId: attempt.destination.channelId ?? null, nonce: attempt.requestNonce,
      claimedAt: new Date(attempt.claimedAt), requestFingerprint: attempt.requestFingerprint };
    let evidence: DiscordModerationReconciliation | null;
    try { evidence = await this.transport.reconcile(request, signal); } catch { return this.readOutcome(actionId); }
    if (!evidence || evidence.outcome.classification === 'unknown') return this.readOutcome(actionId);
    return this.recordOutcome(actionId, attempt.id, evidence.outcome, evidence);
  }

  /** Separate bounded batches prevent unresolved sends from starving newly admitted actions. */
  async recoverDueActions(signal: AbortSignal): Promise<ModerationRecoveryResultDto> {
    invariant(!this.orm.em.isInTransaction(), 'Effect orchestration must begin outside a transaction');
    const em = this.orm.em.fork(), outcomes: ModerationActionOutcomeDto[] = [];
    // Keyset cursors rotate past held targets and unresolvable receipts instead of starving the next page forever.
    const ready = await em.find(ModerationAction, { ...this.scope, state: 'READY', ...(this.readyAfter ? { id: { $gt: this.readyAfter } } : {}) }, { orderBy: { id: 'asc' }, limit: 20 });
    const unresolved = await em.find(ModerationAction, { ...this.scope, state: { $in: ['DISPATCHED', 'UNKNOWN'] },
      ...(this.reconciliationAfter ? { id: { $gt: this.reconciliationAfter } } : {}) }, { orderBy: { id: 'asc' }, limit: 10 });
    this.readyAfter = ready.length === 20 ? ready.at(-1)!.id : null;
    this.reconciliationAfter = unresolved.length === 10 ? unresolved.at(-1)!.id : null;
    for (const action of [...ready, ...unresolved]) {
      if (signal.aborted) break;
      const outcome = action.state === 'READY' ? await this.dispatch(action.id, signal) : await this.reconcile(action.id, signal);
      if (outcome) outcomes.push(outcome);
    }
    return { processed: outcomes.length, outcomes };
  }

  /** Policy effects must still bind accepted findings, retained original evidence, and the latest enabled revision. */
  private async policyAvailable(em: EntityManager, action: ModerationAction, now: Date): Promise<boolean> {
    if (!await this.administration.lockFeatureAdmission(em, this.scope, 'moderation', 'continuation')) return false;
    if (!(await this.administration.readPolicyConfig(em, this.scope)).moderation.enabled) return false;
    const policy = await em.findOne(ModerationPolicyRevision, this.scope, { orderBy: { revisionNumber: 'desc' } });
    if (!policy || policy.id !== action.policyRevisionId || !policy.evaluationConfiguration.decisionThresholds) return false;
    const record = await em.findOne(ModerationCase, { ...this.scope, id: action.caseId! });
    const evidence = await em.findOne(EvidenceRevision, { ...this.scope, id: action.evidenceRevisionId! });
    if (!record || record.currentEvidenceRevisionId !== action.evidenceRevisionId || record.policyRevisionId !== policy.id
      || !evidence || evidence.caseId !== action.caseId || evidence.authorKind !== 'user' || evidence.originalAuthorUserId !== action.targetUserId
      || evidence.payloadPurgedAt || evidence.purgeAfter <= now) return false;
    await action.findings.init();
    const findings = action.findings.getItems();
    const selectedMappings = findings.map(finding => policy.actionMapping.find(mapping => mapping.ruleId === finding.ruleId
      && mapping.supportedDisposition === finding.disposition && mapping.action === action.kind));
    if (action.operationPayload?.kind === 'ban' && Math.max(...selectedMappings.map(mapping => mapping?.deleteMessageSeconds ?? -1)) !== action.operationPayload.deleteMessageSeconds) return false;
    return findings.length > 0 && findings.every(finding => finding.installationId === action.installationId && finding.guildId === action.guildId
      && finding.caseId === action.caseId && finding.evidenceRevisionId === evidence.id && finding.policyRevisionId === policy.id
      && !finding.payloadPurgedAt && finding.purgeAfter > now && !!finding.supportedFacts?.length && !!finding.evidenceReferences?.length
      && policy.rules.some(rule => rule.enabled && rule.id === finding.ruleId && rule.version === finding.ruleVersion)
      && policy.actionMapping.some(mapping => mapping.ruleId === finding.ruleId && mapping.supportedDisposition === finding.disposition
        && mapping.action === action.kind));
  }

  /** Late observations update truth after pause/removal; they can never authorize another send. */
  private async recordOutcome(actionId: string, attemptId: string, outcome: DiscordModerationOutcome, evidence?: DiscordModerationReconciliation): Promise<ModerationActionOutcomeDto> {
    return this.orm.em.fork().transactional(async em => {
      await this.safety.lockAndReadGate(em, this.scope);
      const action = await em.findOneOrFail(ModerationAction, { ...this.scope, id: actionId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const attempt = await em.findOneOrFail(ActionAttempt, { ...this.scope, id: attemptId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (action.activeAttemptId !== attempt.id || action.executionGeneration !== attempt.dispatchGeneration
        || !['DISPATCHED', 'UNKNOWN'].includes(action.state)) return this.view(action);
      const now = new Date();
      if (!attempt.finishedAt) attempt.recordResponse(attempt.dispatchGeneration, { responseClass: outcome.classification === 'confirmed' ? 'success' : outcome.classification,
        httpStatus: outcome.httpStatus ?? null, discordMessageId: outcome.discordMessageId, discordAuditEntryId: outcome.discordAuditEntryId }, now);
      else if (outcome.classification !== 'unknown') attempt.recordReconciliation({ observedAt: now.toISOString(),
        classification: outcome.classification === 'confirmed' ? 'attributable_success' : 'definitively_not_applied',
        source: evidence?.source ?? 'http_response', reference: evidence?.reference ?? `attempt:${attempt.id}` });
      const target = await em.findOneOrFail(TargetExecutionState, { guildId: action.guildId, targetUserId: action.targetUserId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      invariant(target.unresolvedActionId === action.id && target.unresolvedInstallationId === action.installationId, 'Attempt lost its target gate');
      if (action.state === 'DISPATCHED') action.recordOutcome(attempt.id, attempt.dispatchGeneration, outcome, action.rowRevision, now);
      else action.recordReconciliation(attempt.id, attempt.dispatchGeneration, outcome, action.rowRevision, now);
      if (outcome.classification === 'unknown') target.retainUnresolved(action.id, target.generation, now);
      else target.releaseResolved(action.id, target.generation, outcome.classification === 'confirmed' ? 'confirmed' : 'definitively_not_applied', now);
      await this.auditState(em, action, now); return this.view(action);
    });
  }

  /** Unsupported or unavailable pre-dispatch work becomes a durable cancellation without an attempt. */
  private async cancel(actionId: string, reason: string): Promise<ModerationActionOutcomeDto> {
    return this.orm.em.fork().transactional(async em => {
      await this.safety.lockAndReadGate(em, this.scope);
      const action = await em.findOneOrFail(ModerationAction, { ...this.scope, id: actionId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (action.state === 'READY') { const now = new Date(); action.cancelBeforeDispatch(reason, action.rowRevision, now); await this.auditState(em, action, now); }
      return this.view(action);
    });
  }

  /** Only durable origin fields can reconstruct the original staff caller. */
  private caller(action: ModerationAction) {
    invariant(action.actorUserId && action.sourceRequestId, 'Staff provenance is missing');
    return { ...this.scope, actorId: action.actorUserId, sourceRequestId: action.sourceRequestId };
  }
  /** Reconstruct the exact original sanction capability and target; a ban grant never authorizes a kick. */
  private staffOperation(action: ModerationAction) {
    invariant(action.kind === 'ban' || action.kind === 'unban' || action.kind === 'kick', 'Unsupported staff action');
    return { capability: action.kind === 'ban' ? 'moderation.ban' as const : action.kind === 'unban' ? 'moderation.unban' as const
      : 'moderation.kick' as const, targetUserId: action.targetUserId };
  }
  /** Audit stores references and observed state, never raw Discord response text or warning content. */
  private async auditState(em: EntityManager, action: ModerationAction, at: Date): Promise<void> {
    const policy = await this.administration.readPolicyConfig(em, this.scope);
    await this.audit.recordTransition(em, { ...this.scope, createdAt: at, occurredAt: at,
      origin: action.origin === 'staff' ? { kind: 'user', userId: action.actorUserId! } : { kind: 'policy', policyRevisionId: action.policyRevisionId! },
      operation: 'moderation.execution', outcome: action.state === 'DISPATCHED' ? 'intent' : action.state === 'CONFIRMED' ? 'succeeded'
        : action.state === 'UNKNOWN' ? 'unknown' : action.state === 'CANCELED' ? 'canceled' : 'failed',
      references: [{ owner: 'moderation', recordId: action.id, revision: action.rowRevision }], correlationId: action.id,
      idempotencyKey: `moderation-state:${action.id}:${action.rowRevision}`, purgeAfter: new Date(at.getTime() + policy.retention.metadataDays * 86_400_000) });
  }
  /** Read a fresh safe status after a deferred or canceled claim. */
  private async readOutcome(actionId: string): Promise<ModerationActionOutcomeDto> { return this.view(await this.orm.em.fork().findOneOrFail(ModerationAction, { ...this.scope, id: actionId })); }
  /** Report observed external outcome explicitly; READY and UNKNOWN must never be presented as success. */
  private view(action: ModerationAction): ModerationActionOutcomeDto {
    return { actionId: action.id, kind: action.kind, state: action.state, unresolved: ['DISPATCHED', 'UNKNOWN'].includes(action.state),
      reasonCode: action.outcomeSummary?.code ?? null, ...(action.outcomeSummary?.discordMessageId ? { discordMessageId: action.outcomeSummary.discordMessageId } : {}),
      ...(action.outcomeSummary?.discordAuditEntryId ? { discordAuditEntryId: action.outcomeSummary.discordAuditEntryId } : {}) };
  }
}
