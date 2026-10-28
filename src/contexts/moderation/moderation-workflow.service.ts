/** Durable text-only observation→assessment ownership; workers execute capabilities and never choose sanctions. */
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import { ModerationTaskService, type StoredModerationCompletion } from '../../platform/jobs/moderation-task.service.js';
import type { ModerationCompletionReference } from '../../platform/jobs/moderation-task.contracts.js';
import type { ObservationResult } from '../../ai/contracts/observation.contracts.js';
import type { AssessmentResult } from '../../ai/contracts/assessment.contracts.js';
import type { ModerationEvidence, ModerationObservation, ModerationPolicySnapshot } from './contracts.js';
import { ModerationPolicy } from './moderation.policy.js';
import { ModerationCase } from './entities/moderation-case.entity.js';
import { ModerationPolicyRevision } from './entities/moderation-policy-revision.entity.js';
import { EvidenceRevision } from './entities/evidence-revision.entity.js';
import { ModerationFinding } from './entities/moderation-finding.entity.js';
import { ModerationAction, type ModerationOperation } from './entities/moderation-action.entity.js';

export class ModerationWorkflowService {
  /** Owner persistence and pure policy only; all provider/Discord I/O belongs outside this service. */
  constructor(private readonly orm: MikroORM, private readonly scope: InstallationScope,
    private readonly administration: GuildLifecycleService, private readonly tasks = new ModerationTaskService(),
    private readonly policy = new ModerationPolicy(), private readonly audit = new AuditRecorder()) {}

  /** Bounded durable scans recover lost wakeups without replaying provider calls or accepting detached payloads. */
  async runMaintenance(): Promise<void> {
    await this.tasks.recoverExpired(this.orm.em.fork());
    const references = await this.tasks.pendingResults(this.orm.em.fork(), this.scope);
    for (const reference of references) await this.acceptResult(reference);
    const pending = await this.orm.em.fork().find(ModerationCase, { ...this.scope, workflowPhase: 'captured', expectedTaskId: null },
      { limit: 20, orderBy: { updatedAt: 'asc', id: 'asc' }, fields: ['id'] });
    for (const record of pending) await this.admitCase(record.id);
  }

  /** Observe the retained body once, then assess every enabled body rule with a separate bounded task. */
  async admitCase(caseId: string): Promise<'admitted' | 'incomplete' | 'unchanged'> {
    return this.orm.em.fork().transactional(async em => {
      const gate = await this.administration.lockFeatureAdmission(em, this.scope, 'moderation');
      if (!gate) return 'unchanged';
      const record = await em.findOne(ModerationCase, { ...this.scope, id: caseId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!record || record.workflowPhase !== 'captured' || record.expectedTaskId !== null || !record.currentEvidenceRevisionId) return 'unchanged';
      const now = new Date(), current = await this.administration.readPolicyConfig(em, this.scope);
      const published = await em.findOne(ModerationPolicyRevision, this.scope, { orderBy: { revisionNumber: 'desc' } });
      const evidence = await em.findOne(EvidenceRevision, { ...this.scope, id: record.currentEvidenceRevisionId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const enabled = published?.rules.filter(rule => rule.enabled) ?? [];
      /** Complete this case with an explicit missing-evidence reason instead of creating an assessment. */
      const incomplete = (reason: string): 'incomplete' => { record.recordDisposition('incomplete', reason, record.rowRevision, now); return 'incomplete'; };
      if (!current.moderation.enabled || !published || !published.evaluationConfiguration.decisionThresholds) return incomplete('policy_disabled');
      if (record.policyRevisionId !== published.id) record.adoptPolicy(published.id, record.rowRevision, now);
      if (enabled.length === 0) return incomplete('enabled_rule_missing');
      const rule = enabled[0]!;
      if (published.requiredEvidence.some(item => item.originalMedia && enabled.some(rule => rule.id === item.ruleId))) return incomplete('original_media_uninspected');
      if (!evidence || evidence.payloadPurgedAt !== null || evidence.purgeAfter <= now || evidence.originalContent === null
        || evidence.captureCoverage.contentAccess !== 'available' || evidence.authorKind !== 'user' || !evidence.originalAuthorUserId) return incomplete('original_evidence_unavailable');
      const payload = { schemaVersion: 1 as const, kind: 'moderation.observe' as const, input: { schemaVersion: 1 as const,
        evidenceRevisionId: evidence.id, content: evidence.originalContent, sourceReferences: [`evidence:${evidence.id}`], maxOutputTokens: 1024 } };
      if (evidence.originalContent.length > 16_000 || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 30 * 1024) return incomplete('original_body_exceeds_assessment_bound');
      const deadline = new Date(Math.min(now.getTime() + 120_000, evidence.purgeAfter.getTime()));
      const taskId = this.tasks.registerTask(em, { ...this.scope, caseId: record.id, ruleId: rule.id, caseGeneration: record.generation + 1,
        sourceEventId: evidence.originalEventId, evidenceRevisionId: evidence.id, policyRevisionId: published.id, safetyRevision: gate.safetyRevision,
        model: published.evaluationConfiguration.observationModel, promptVersion: published.evaluationConfiguration.promptVersion,
        payload, now, deadline, purgeAfter: new Date(Math.min(evidence.purgeAfter.getTime(), now.getTime() + current.retention.payloadDays * 86400_000)) });
      record.expectTask({ taskId, phase: 'observing', evidenceRevisionId: evidence.id, policyRevisionId: published.id, expectedRowRevision: record.rowRevision, at: now });
      return 'admitted';
    });
  }

  /** Resolve durable result references under owner locks, then copy accepted meaning and acknowledgment atomically. */
  async acceptResult(reference: ModerationCompletionReference): Promise<'accepted' | 'discarded' | 'already_handled'> {
    return this.orm.em.fork().transactional(async em => {
      const gate = await this.administration.lockFeatureAdmission(em, this.scope, 'moderation', 'continuation');
      const record = await em.findOne(ModerationCase, { ...this.scope, id: reference.caseId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const evidence = record?.currentEvidenceRevisionId ? await em.findOne(EvidenceRevision,
        { ...this.scope, id: record.currentEvidenceRevisionId }, { lockMode: LockMode.PESSIMISTIC_WRITE }) : null;
      const completion = await this.tasks.readCompletion(em, this.scope, reference);
      if (!completion || completion.acknowledged) return 'already_handled';
      const now = new Date(), current = await this.administration.readPolicyConfig(em, this.scope);
      const published = await em.findOne(ModerationPolicyRevision, this.scope, { orderBy: { revisionNumber: 'desc' } });
      const expected = record?.expectedTaskId === completion.taskId && record.generation === completion.caseGeneration;
      const valid = gate && expected && current.moderation.enabled && published && record && evidence
        && gate.safetyRevision === completion.safetyRevision && published.id === completion.policyRevisionId
        && record.policyRevisionId === published.id && record.currentEvidenceRevisionId === completion.evidenceRevisionId
        && evidence.payloadPurgedAt === null && evidence.purgeAfter > now && completion.deadline > now
        && completion.currentAttempt && completion.outcome === 'success' && completion.payload !== null && completion.prepared !== null
        && record.workflowPhase === (completion.kind === 'moderation.observe' ? 'observing' : 'assessing');
      let outcome: 'accepted' | 'discarded';
      if (!valid || !published || !record || !evidence) {
        if (record && expected) record.recordDisposition('incomplete', 'assessment_unavailable_or_stale', record.rowRevision, now);
        await this.tasks.acknowledge(em, this.scope, completion, 'discarded', 'assessment_unavailable_or_stale', now);
        outcome = 'discarded';
      } else if (completion.kind === 'moderation.observe') {
        outcome = await this.acceptObservation(em, record, evidence, published, completion, gate.safetyRevision, current.retention.payloadDays, now);
      } else {
        outcome = await this.acceptAssessment(em, record, evidence, published, completion, gate.safetyRevision, current.retention.payloadDays, current.retention.metadataDays, now);
      }
      // Disposition and acknowledgment are audited in the same transaction, including stale or incomplete results.
      await this.audit.recordTransition(em, { ...this.scope, occurredAt: now,
        origin: { kind: 'system', component: 'moderation.workflow' }, operation: 'moderation.result',
        outcome: outcome === 'accepted' ? 'succeeded' : 'discarded', correlationId: completion.caseId,
        idempotencyKey: `moderation-result:${completion.resultId}`,
        references: [{ owner: 'jobs', recordId: completion.resultId, revision: null },
          ...(record ? [{ owner: 'moderation', recordId: record.id, revision: record.rowRevision }] : [])],
        purgeAfter: new Date(now.getTime() + current.retention.metadataDays * 86400_000) });
      return outcome;
    });
  }

  /** Accepted original quotes are copied into the next immutable input before disposable observation acknowledgment. */
  private async acceptObservation(em: EntityManager, record: ModerationCase, evidence: EvidenceRevision, published: ModerationPolicyRevision,
    completion: StoredModerationCompletion, safetyRevision: number, payloadDays: number, now: Date): Promise<'accepted' | 'discarded'> {
    const observed = completion.payload as unknown as ObservationResult;
    const bound = this.observation(observed, evidence, published.evaluationConfiguration.observationModel);
    if (!bound || this.policy.supportedFacts(this.evidence(evidence, now), bound) === null) {
      record.recordDisposition('incomplete', 'observation_incomplete', record.rowRevision, now);
      await this.tasks.acknowledge(em, this.scope, completion, 'discarded', 'observation_incomplete', now); return 'discarded';
    }
    if (!this.queueAssessment(em, record, evidence, published, completion.ruleId, observed, completion.resultId, safetyRevision, payloadDays, now)) {
      record.recordDisposition('incomplete', 'assessment_input_unavailable', record.rowRevision, now);
      await this.tasks.acknowledge(em, this.scope, completion, 'discarded', 'assessment_input_unavailable', now); return 'discarded';
    }
    await this.tasks.acknowledge(em, this.scope, completion, 'accepted', 'original_quotes_copied', now); return 'accepted';
  }

  /** Pure policy decides meaning; accepted finding/action intent and result acknowledgment share this transaction. */
  private async acceptAssessment(em: EntityManager, record: ModerationCase, evidence: EvidenceRevision, published: ModerationPolicyRevision,
    completion: StoredModerationCompletion, safetyRevision: number, payloadDays: number, metadataDays: number, now: Date): Promise<'accepted' | 'discarded'> {
    const prepared = completion.prepared;
    const observation = prepared?.kind === 'moderation.assess' ? this.observation(prepared.observation, evidence, published.evaluationConfiguration.observationModel) : null;
    const rule = published.rules.find(item => item.id === completion.ruleId && item.enabled);
    if (!observation || !rule || prepared?.kind !== 'moderation.assess') {
      record.recordDisposition('incomplete', 'observation_binding_missing', record.rowRevision, now);
      await this.tasks.acknowledge(em, this.scope, completion, 'discarded', 'observation_binding_missing', now); return 'discarded';
    }
    const decision = this.policy.evaluateRule({ enabled: true, policy: published as ModerationPolicySnapshot, ruleId: rule.id,
      evidence: this.evidence(evidence, now), observation, assessment: completion.payload as unknown as AssessmentResult });
    const finding = new ModerationFinding({ ...this.scope, createdAt: now, caseId: record.id, evidenceRevisionId: evidence.id,
      policyRevisionId: published.id, ruleId: rule.id, ruleVersion: rule.version, observationTaskResultId: prepared.observationResultId,
      assessmentTaskResultId: completion.resultId, supportedFacts: decision.supportedFacts.map(item => item.quote),
      evidenceReferences: decision.supportedFacts.map(item => ({ kind: 'original_body' as const, start: item.start, end: item.end, description: item.quote })),
      exclusions: decision.reasonCode === 'configured_exclusion_applies' ? ['configured_exclusion_applies'] : [],
      coverage: { schemaVersion: 1, inspectedBody: observation.inspectedBody, inspectedAttachmentIds: [], limitations: [...observation.limitations] },
      disposition: decision.disposition, acceptedAt: now, purgeAfter: evidence.purgeAfter });
    const previous = await em.find(ModerationFinding, { ...this.scope, caseId: record.id, evidenceRevisionId: evidence.id,
      policyRevisionId: published.id, payloadPurgedAt: null }, { limit: 101, orderBy: { acceptedAt: 'asc', id: 'asc' } });
    if (previous.length > 100 || previous.some(item => item.ruleId === rule.id)) {
      record.recordDisposition('incomplete', 'finding_sequence_conflict', record.rowRevision, now);
      await this.tasks.acknowledge(em, this.scope, completion, 'discarded', 'finding_sequence_conflict', now); return 'discarded';
    }
    em.persist(finding);
    await this.audit.recordTransition(em, { ...this.scope, occurredAt: now,
      origin: { kind: 'policy', policyRevisionId: published.id }, operation: 'moderation.finding', outcome: 'succeeded',
      correlationId: record.id, idempotencyKey: `moderation-finding:${finding.id}`,
      references: [{ owner: 'moderation', recordId: finding.id, revision: null }],
      purgeAfter: new Date(now.getTime() + metadataDays * 86400_000) });
    const findings = [...previous, finding];
    const next = published.rules.find(item => item.enabled && !findings.some(accepted => accepted.ruleId === item.id && accepted.ruleVersion === item.version));
    if (next) {
      if (!this.queueAssessment(em, record, evidence, published, next.id, prepared.observation, prepared.observationResultId, safetyRevision, payloadDays, now)) {
        record.recordDisposition('incomplete', 'assessment_input_unavailable', record.rowRevision, now);
      }
    } else {
      record.acceptFinding(completion.taskId, findings, completion.caseGeneration, record.rowRevision, now);
      await this.createAction(em, record, evidence, published, findings, safetyRevision, metadataDays, now);
    }
    await this.tasks.acknowledge(em, this.scope, completion, 'accepted', decision.reasonCode, now); return 'accepted';
  }

  /** Copy the same accepted observation into one next-rule input; the case admits only this exact generation. */
  private queueAssessment(em: EntityManager, record: ModerationCase, evidence: EvidenceRevision, published: ModerationPolicyRevision,
    ruleId: string, observed: ObservationResult, observationResultId: string, safetyRevision: number, payloadDays: number, now: Date): boolean {
    const bound = this.observation(observed, evidence, published.evaluationConfiguration.observationModel);
    if (!bound) return false;
    let assessment;
    try { assessment = this.policy.prepareRuleAssessment(published as ModerationPolicySnapshot, ruleId, this.evidence(evidence, now), bound); }
    catch { return false; }
    const payload = { schemaVersion: 1 as const, kind: 'moderation.assess' as const, input: assessment, observation: observed, observationResultId };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 32 * 1024) return false;
    const taskId = this.tasks.registerTask(em, { ...this.scope, caseId: record.id, ruleId, caseGeneration: record.generation + 1,
      sourceEventId: evidence.originalEventId, evidenceRevisionId: evidence.id, policyRevisionId: published.id, safetyRevision,
      model: published.evaluationConfiguration.assessmentModel, promptVersion: published.evaluationConfiguration.promptVersion,
      payload, now, deadline: new Date(Math.min(now.getTime() + 120_000, evidence.purgeAfter.getTime())),
      purgeAfter: new Date(Math.min(evidence.purgeAfter.getTime(), now.getTime() + payloadDays * 86400_000)) });
    record.expectTask({ taskId, phase: 'assessing', evidenceRevisionId: evidence.id, policyRevisionId: published.id, expectedRowRevision: record.rowRevision, at: now });
    return true;
  }

  /** Select one strongest configured effect after all rules finish; accepted explanations remain separately linked. */
  private async createAction(em: EntityManager, record: ModerationCase, evidence: EvidenceRevision, published: ModerationPolicyRevision,
    findings: readonly ModerationFinding[], safetyRevision: number, metadataDays: number, now: Date): Promise<void> {
    if (!evidence.originalAuthorUserId) return;
    const mapped = findings.flatMap(finding => {
      const mapping = published.actionMapping.find(item => item.ruleId === finding.ruleId && item.supportedDisposition === finding.disposition
        && item.action !== 'none' && (item.action !== 'ban' || finding.disposition === 'violation'));
      return mapping ? [{ finding, mapping }] : [];
    });
    const bans = mapped.filter(item => item.mapping.action === 'ban');
    const deletionSeconds = bans.length ? Math.max(...bans.map(item => item.mapping.deleteMessageSeconds)) : 0;
    // Every linked finding must support this exact operation, including its history-deletion scope.
    const contributing = bans.length ? bans.filter(item => item.mapping.deleteMessageSeconds === deletionSeconds)
      : mapped.filter(item => item.mapping.action === 'warning');
    if (contributing.length === 0) return;
    const explanation = contributing.map(item => `${item.finding.ruleId} (${item.finding.ruleVersion})`).join(', ');
    const operation: Exclude<ModerationOperation, { kind: 'unban' }> = bans.length
      ? { schemaVersion: 1, kind: 'ban', reason: `Yuna case ${record.id}; rules ${explanation}`.slice(0, 512),
        deleteMessageSeconds: deletionSeconds }
      : { schemaVersion: 1, kind: 'warning', text: `Your message was flagged under ${contributing.map(item => {
        const rule = published.rules.find(rule => rule.id === item.finding.ruleId)!; return `rule ${rule.id}: ${rule.description}`;
      }).join('; ')}`.slice(0, 1900), destination: { kind: 'direct_message' }, allowedMentions: { users: [], roles: [], everyone: false } };
    const action = new ModerationAction({ ...this.scope, createdAt: now, targetUserId: evidence.originalAuthorUserId,
      deduplicationKey: `moderation:${record.id}:${evidence.id}:${published.id}`, auditCorrelation: record.id,
      safetyRevision, operationPayload: operation, authority: { origin: 'policy', caseId: record.id, evidenceRevisionId: evidence.id,
        policyRevisionId: published.id, findings: contributing.map(item => item.finding) }, purgeAfter: evidence.purgeAfter });
    em.persist(action);
    await this.audit.recordTransition(em, { ...this.scope, occurredAt: now,
      origin: { kind: 'policy', policyRevisionId: published.id }, operation: 'moderation.intent', outcome: 'intent',
      correlationId: record.id, idempotencyKey: `moderation-intent:${action.id}`,
      references: [{ owner: 'moderation', recordId: action.id, revision: action.rowRevision }],
      purgeAfter: new Date(now.getTime() + metadataDays * 86400_000) });
  }

  /** AI metadata must match the admitted body/model; limitations preserve uncertainty rather than becoming suspicion. */
  private observation(result: ObservationResult, evidence: EvidenceRevision, model: string): ModerationObservation | null {
    if (!result || result.schemaVersion !== 1 || result.outcome !== 'observed' || result.evidenceRevisionId !== evidence.id
      || result.requestedModel !== model || !Array.isArray(result.sourceReferences) || result.sourceReferences.length !== 1
      || result.sourceReferences[0] !== `evidence:${evidence.id}` || !Array.isArray(result.facts) || !Array.isArray(result.limitations)
      || result.limitations.length !== 0 || result.inspectedBody !== true) return null;
    return { evidenceRevisionId: evidence.id, inspectedBody: result.inspectedBody, facts: result.facts, limitations: result.limitations };
  }
  /** Expose plain retained evidence facts to pure policy; later edits/current-source markers play no role. */
  private evidence(row: EvidenceRevision, now: Date): ModerationEvidence {
    return { ...this.scope, caseId: row.caseId, evidenceRevisionId: row.id, originalEventId: row.originalEventId, contentHash: row.originalContentHash,
      sourceUse: 'original_evidence', sourceChannelId: row.sourceChannelId, originalContent: row.originalContent, authorKind: row.authorKind, originalAuthorUserId: row.originalAuthorUserId,
      attachments: row.originalAttachmentDescriptors ?? [], captureCoverage: row.captureCoverage, missingReasons: row.missingReasons,
      available: row.payloadPurgedAt === null && row.purgeAfter > now };
  }
}
