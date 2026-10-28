/** Own canonical original-message cases, immutable policy publication and local retention transitions. */
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { LockMode } from '@mikro-orm/core';
import { isDeepStrictEqual } from 'node:util';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import type { TrustedCallerContext } from '../administration/contracts.js';
import { IntakeService, validateOriginalCapture, type OriginalMessageCapture, type OriginalMessageProvenance, type IntakeRetention } from '../../platform/intake/intake.service.js';
import type { IntakeEvent } from '../../platform/intake/entities/intake-event.entity.js';
import { assertDate, assertDiscordId, copyJson, invariant } from '../../platform/db/entity-values.js';
import { validatePolicyConfig, type ModerationPolicyConfiguration, type YunaPolicyConfig } from '../../platform/config/policy-config.js';
import { ModerationCase } from './entities/moderation-case.entity.js';
import { EvidenceRevision } from './entities/evidence-revision.entity.js';
import { ModerationPolicyRevision } from './entities/moderation-policy-revision.entity.js';
import { ModerationFinding } from './entities/moderation-finding.entity.js';
import { ModerationAction } from './entities/moderation-action.entity.js';
import type { IngestMessageDto, ModerationCaseDto, ModerationIntakeResult, ReportMessageDto } from './dto/moderation-intake.dto.js';

/** Every receipt and its case/evidence commit together; these methods perform no provider or Discord I/O. */
export class ModerationService {
  /** Collaborators supply owner-controlled gate/config facts; no private Administration entity access. */
  constructor(private readonly orm: MikroORM, private readonly scope: InstallationScope,
    private readonly administration: GuildLifecycleService, private readonly intake: IntakeService, private readonly audit = new AuditRecorder()) {}

  /** Admit only authentic MESSAGE_CREATE capture; repeats return the existing case without rewriting evidence. */
  async ingestMessage(provenance: OriginalMessageProvenance, input: IngestMessageDto): Promise<ModerationIntakeResult> {
    validateOriginalCapture(provenance, input);
    invariant(provenance.guildId === this.scope.guildId, 'Original belongs to another guild');
    const capture = copyJson(input);
    const trusted = { ...provenance, observedAt: new Date(provenance.observedAt), createdAt: provenance.createdAt ? new Date(provenance.createdAt) : null };
    return this.orm.em.fork().transactional(async em => {
      if (!await this.administration.lockFeatureAdmission(em, this.scope, 'moderation')) return { status: 'ignored', reasonCode: 'admission_closed' };
      const policy = await this.latestPolicy(em);
      if (!policy) return { status: 'ignored', reasonCode: 'policy_missing' };
      const now = new Date(), retention = (await this.administration.readPolicyConfig(em, this.scope)).retention;
      const received = await this.intake.receiveOriginal(em, this.scope, trusted, capture, now, this.intakeRetention(now, retention));
      const record = await this.canonicalCase(em, provenance.channelId, provenance.messageId, policy.id, now);
      if (!received.duplicate) {
        this.captureOriginal(em, record, received.event, now, retention.evidenceDays);
        received.receipt.complete(received.receipt.claimGeneration, 'handled', record.id, now);
      }
      return { status: 'recorded', case: this.caseDto(record, received.duplicate) };
    });
  }

  /** A report references the authentic original only; its allegation/reporter never becomes evidence/subject. */
  async ingestReport(caller: TrustedCallerContext, input: ReportMessageDto): Promise<ModerationIntakeResult> {
    this.checkCaller(caller);
    for (const id of [input.channelId, input.messageId]) assertDiscordId(id);
    invariant(typeof input.allegation === 'string' && input.allegation.length <= 4000, 'Report allegation must be bounded');
    const dto = { ...input };
    return this.orm.em.fork().transactional(async em => {
      if (!await this.administration.lockFeatureAdmission(em, this.scope, 'moderation')) return { status: 'ignored', reasonCode: 'admission_closed' };
      const policy = await this.latestPolicy(em);
      if (!policy) return { status: 'ignored', reasonCode: 'policy_missing' };
      const now = new Date(), retention = (await this.administration.readPolicyConfig(em, this.scope)).retention;
      const reference = { guildId: this.scope.guildId, channelId: dto.channelId, messageId: dto.messageId };
      const received = await this.intake.receiveReport(em, this.scope, { ...reference, actorId: caller.actorId,
        requestId: caller.sourceRequestId, allegation: dto.allegation }, now, this.intakeRetention(now, retention));
      const record = await this.canonicalCase(em, dto.channelId, dto.messageId, policy.id, now);
      if (!received.duplicate) {
        if (!record.currentEvidenceRevisionId) {
          const original = await this.intake.findOriginal(em, this.scope, reference);
          if (original && original.payloadPurgedAt === null && original.purgeAfter > now) this.captureOriginal(em, record, original, now, retention.evidenceDays);
          else record.recordDisposition('incomplete', 'original_capture_missing', record.rowRevision, now);
        }
        received.receipt.complete(received.receipt.claimGeneration, 'handled', record.id, now);
      }
      return { status: 'recorded', case: this.caseDto(record, received.duplicate) };
    });
  }

  /** Configuration owner has already checked authority and locked installation/safety; publication joins that transaction. */
  async publishPolicy(em: EntityManager, caller: TrustedCallerContext, value: YunaPolicyConfig, at: Date): Promise<{ policyRevisionId: string | null; changed: boolean }> {
    invariant(em.isInTransaction(), 'Policy publication requires the owner transaction');
    this.checkCaller(caller); assertDate(at, 'at');
    const config = validatePolicyConfig(value), latest = await this.latestPolicy(em), configured = config.moderation.policy;
    const changed = configured !== null && (!latest || !isDeepStrictEqual(this.policyValues(latest), configured));
    if (!changed && config.moderation.enabled) return { policyRevisionId: latest?.id ?? null, changed: false };
    const pending = await em.find(ModerationCase, { ...this.scope, workflowPhase: { $ne: 'complete' } },
      { limit: 1001, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    invariant(pending.length <= 1000, 'Too many pending moderation cases for one atomic publication; drain pending work first');
    let revision = latest;
    if (changed && configured) {
      revision = new ModerationPolicyRevision({ ...this.scope, createdAt: at, ...configured, revisionNumber: (latest?.revisionNumber ?? 0) + 1,
        publisherUserId: caller.actorId, publisherRequestId: caller.sourceRequestId, publishedAt: at });
      em.persist(revision);
    }
    for (const record of pending) {
      if (!config.moderation.enabled) record.recordDisposition('incomplete', 'moderation_disabled', record.rowRevision, at);
      else if (revision) record.adoptPolicy(revision.id, record.rowRevision, at);
    }
    return { policyRevisionId: revision?.id ?? null, changed };
  }

  /** Fence a bounded batch in an already-locked owner transaction; callers repeat while pending remains. */
  async invalidatePending(em: EntityManager, reason: string, at: Date): Promise<{ changed: number; pending: boolean }> {
    invariant(em.isInTransaction(), 'Invalidation requires owner transaction');
    invariant(/^[a-z0-9_.-]{1,120}$/.test(reason), 'Invalidation requires a bounded reason code');
    const pending = await em.find(ModerationCase, { ...this.scope, workflowPhase: { $ne: 'complete' } },
      { limit: 50, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const record of pending) {
      record.recordDisposition('incomplete', reason, record.rowRevision, at);
      await this.auditCleanup(em, record, 'moderation.invalidation', at);
    }
    await em.flush();
    return { changed: pending.length, pending: await em.count(ModerationCase, { ...this.scope, workflowPhase: { $ne: 'complete' } }) > 0 };
  }

  /** Expired original evidence fences pending work and ready intents before its payload is erased. */
  async runRetention(em: EntityManager, at: Date): Promise<void> {
    invariant(em.isInTransaction(), 'Moderation retention requires owner transaction');
    const evidence = await em.find(EvidenceRevision, { ...this.scope, payloadPurgedAt: null, purgeAfter: { $lte: at } },
      { limit: 50, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const row of evidence) {
      const record = await em.findOne(ModerationCase, { ...this.scope, currentEvidenceRevisionId: row.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (record && record.workflowPhase !== 'complete') {
        record.recordDisposition('incomplete', 'original_evidence_expired', record.rowRevision, at);
        await this.auditCleanup(em, record, 'moderation.invalidation', at);
      }
      const actions = await em.find(ModerationAction, { ...this.scope, evidenceRevisionId: row.id, state: 'READY' }, { limit: 101, lockMode: LockMode.PESSIMISTIC_WRITE });
      invariant(actions.length <= 100, 'Original evidence has too many ready actions for bounded retention');
      for (const action of actions) {
        action.cancelBeforeDispatch('original_evidence_expired', action.rowRevision, at);
        await this.auditCleanup(em, action, 'moderation.cancellation', at);
      }
      row.purgePayload(at, 'retention');
    }
    const findings = await em.find(ModerationFinding, { ...this.scope, payloadPurgedAt: null, purgeAfter: { $lte: at } },
      { limit: 50, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const row of findings) row.purgePayload(at, 'retention');
    const actions = await em.find(ModerationAction, { ...this.scope, payloadPurgedAt: null, purgeAfter: { $lte: at } },
      { limit: 50, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const row of actions) row.purgePayload(at, 'retention', row.rowRevision);
  }

  /** Removal erases bounded payload batches and explicitly retains explanation/replay/accounting references. */
  async cleanupForRemoval(em: EntityManager, at: Date): Promise<{ disposition: 'pending' | 'retained' | 'complete'; reasonCode: string | null }> {
    const invalidation = await this.invalidatePending(em, 'guild_removal', at);
    const evidence = await em.find(EvidenceRevision, { ...this.scope, payloadPurgedAt: null }, { limit: 50, lockMode: LockMode.PESSIMISTIC_WRITE });
    const findings = await em.find(ModerationFinding, { ...this.scope, payloadPurgedAt: null }, { limit: 50, lockMode: LockMode.PESSIMISTIC_WRITE });
    const actions = await em.find(ModerationAction, { ...this.scope, payloadPurgedAt: null }, { limit: 50, lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const row of evidence) row.purgePayload(at, 'guild_removal');
    for (const row of findings) row.purgePayload(at, 'guild_removal');
    for (const row of actions) {
      if (row.state === 'READY') {
        row.cancelBeforeDispatch('guild_removal', row.rowRevision, at);
        await this.auditCleanup(em, row, 'moderation.cancellation', at);
      }
      row.purgePayload(at, 'guild_removal', row.rowRevision);
    }
    await em.flush();
    if (invalidation.pending || await em.count(EvidenceRevision, { ...this.scope, payloadPurgedAt: null })
      || await em.count(ModerationFinding, { ...this.scope, payloadPurgedAt: null })
      || await em.count(ModerationAction, { ...this.scope, payloadPurgedAt: null })) return { disposition: 'pending', reasonCode: 'moderation_payloads_pending' };
    const guidance = await em.execute<{ present: boolean }[]>(
      "select exists(select 1 from moderation_policy_revision where installation_id=? and guild_id=? and jsonb_exists(evaluation_configuration, 'serverRules')) as present",
      [this.scope.installationId, this.scope.guildId]);
    if (guidance[0]?.present) return { disposition: 'retained', reasonCode: 'moderation_policy_guidance_retained' };
    return await em.count(ModerationCase, this.scope) || await em.count(ModerationPolicyRevision, this.scope)
      ? { disposition: 'retained', reasonCode: 'moderation_provenance_metadata' } : { disposition: 'complete', reasonCode: null };
  }

  /** Record cleanup decisions with bounded references before payload removal; repeated scans cannot duplicate a transition. */
  private async auditCleanup(em: EntityManager, record: ModerationCase | ModerationAction, operation: string, at: Date): Promise<void> {
    const config = await this.administration.readPolicyConfig(em, this.scope);
    await this.audit.recordTransition(em, { ...this.scope, occurredAt: at, origin: { kind: 'system', component: 'moderation.cleanup' },
      operation, outcome: 'canceled', correlationId: record.id, idempotencyKey: `${operation}:${record.id}:${record.rowRevision}`,
      references: [{ owner: 'moderation', recordId: record.id, revision: record.rowRevision }],
      purgeAfter: new Date(at.getTime() + config.retention.metadataDays * 86400_000) });
  }

  /** Local canonical identity is serialized by the installation admission lock. */
  private async canonicalCase(em: EntityManager, channelId: string, messageId: string, policyRevisionId: string, now: Date): Promise<ModerationCase> {
    const existing = await em.findOne(ModerationCase, { ...this.scope, sourceChannelId: channelId, sourceMessageId: messageId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (existing) return existing;
    const record = new ModerationCase({ ...this.scope, createdAt: now, sourceChannelId: channelId, sourceMessageId: messageId, policyRevisionId });
    em.persist(record); return record;
  }

  /** Build evidence from the stored first-create snapshot, never from a report or duplicate event's arguments. */
  private captureOriginal(em: EntityManager, record: ModerationCase, event: IntakeEvent, now: Date, evidenceDays: number): void {
    if (record.currentEvidenceRevisionId) return;
    invariant(event.eventKind === 'message_create' && !event.isCurrentSourceMarker && event.payloadPurgedAt === null, 'Original capture is unavailable');
    const capture = event.snapshot?.fields.capture as unknown as OriginalMessageCapture | undefined;
    invariant(capture !== undefined, 'Stored original capture is missing');
    const purgeAfter = new Date(event.observedAt.getTime() + evidenceDays * 86400_000);
    if (purgeAfter <= now) { record.recordDisposition('incomplete', 'original_evidence_expired', record.rowRevision, now); return; }
    const evidence = new EvidenceRevision({ ...this.scope, createdAt: now, caseId: record.id, captureRevision: 1, originalEventId: event.id,
      sourceChannelId: record.sourceChannelId, sourceMessageId: record.sourceMessageId, originalAuthorUserId: event.authorUserId,
      authorKind: event.authorKind, webhookId: event.webhookId, messageType: event.messageType ?? 0, originalCreatedAt: event.messageCreatedAt,
      capturedAt: now, originalContent: capture.originalContent, originalAttachmentDescriptors: capture.attachments.map(item => ({ ...item })), artifactReferences: [],
      captureCoverage: { schemaVersion: 1, contentAccess: capture.contentAccess, body: capture.originalContent === null ? 'missing' : 'captured',
        attachments: capture.attachmentsComplete ? capture.attachments.length ? 'complete' : 'none' : capture.attachments.length ? 'partial' : 'missing' },
      missingReasons: [...capture.missingReasons], purgeAfter });
    em.persist(evidence); record.completeOriginalCapture(evidence, record.rowRevision, now);
    if (capture.originalContent === null) record.recordDisposition('incomplete', 'original_body_missing', record.rowRevision, now);
  }

  /** Latest immutable revision is safe under the installation lock shared with configuration publication. */
  private latestPolicy(em: EntityManager): Promise<ModerationPolicyRevision | null> {
    return em.findOne(ModerationPolicyRevision, this.scope, { orderBy: { revisionNumber: 'desc' } });
  }
  /** Compare semantic policy contents without publication provenance. */
  private policyValues(policy: ModerationPolicyRevision): ModerationPolicyConfiguration {
    return { rules: policy.rules, requiredEvidence: policy.requiredEvidence, exclusions: policy.exclusions,
      evaluationConfiguration: policy.evaluationConfiguration, actionMapping: policy.actionMapping };
  }
  /** Retention values have already passed persisted configuration validation. */
  private intakeRetention(now: Date, retention: YunaPolicyConfig['retention']): IntakeRetention {
    return { purgeAfter: new Date(now.getTime() + retention.payloadDays * 86400_000),
      metadataPurgeAfter: new Date(now.getTime() + retention.metadataDays * 86400_000) };
  }
  /** Caller provenance is identity, not publication/enforcement authority; composition checks that separately. */
  private checkCaller(caller: TrustedCallerContext): void {
    invariant(caller.guildId === this.scope.guildId && caller.installationId === this.scope.installationId, 'Caller belongs to another installation');
    assertDiscordId(caller.actorId);
    invariant(/^[^\s\p{Cc}]{1,200}$/u.test(caller.sourceRequestId), 'Caller request provenance is required');
  }
  /** Expose progress and references without leaking retained original content or ORM entities. */
  private caseDto(record: ModerationCase, duplicate: boolean): ModerationCaseDto {
    return { caseId: record.id, evidenceRevisionId: record.currentEvidenceRevisionId, policyRevisionId: record.policyRevisionId,
      phase: record.workflowPhase, disposition: record.disposition, reasonCode: record.captureReason, duplicate };
  }
}
