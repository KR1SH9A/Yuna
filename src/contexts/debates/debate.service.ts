/** Own explicit Debate consent, bounded submitted transcripts, frozen Jev evaluation and privacy cleanup. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { AssessmentResult } from '../../ai/contracts/assessment.contracts.js';
import { assertDiscordId, copyJson, invariant } from '../../platform/db/entity-values.js';
import { DebateTaskService, type StoredDebateCompletion } from '../../platform/jobs/debate-task.service.js';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import type { TrustedCallerContext } from '../administration/contracts.js';
import { DebateSession, type EvaluationVariant } from './entities/debate-session.entity.js';
import { ParticipantConsent } from './entities/participant-consent.entity.js';
import { TranscriptEntry } from './entities/transcript-entry.entity.js';
import { TranscriptSnapshot } from './entities/transcript-snapshot.entity.js';
import { RubricRevision } from './entities/rubric-revision.entity.js';
import { DebateEvaluation } from './entities/debate-evaluation.entity.js';
import { DebateScoringPolicy, readDebateRubric, transcriptHash, type FrozenDebateInput, type FrozenDebateEntry } from './debate-scoring.policy.js';
import { parseDebateAction, parseDebateProposal, type DebateSessionResponseDto } from './dto/debate-session.dto.js';
import type { DebateResultResponseDto } from './dto/debate-result.dto.js';
import { DebateAudit } from './debate-audit.js';
import type { AuditOrigin } from '../../platform/audit/entities/audit-entry.entity.js';

export class DebateService {
  /** Composition chooses the Jev model; no command can select a provider or grant permissions. */
  constructor(private readonly orm: MikroORM, readonly scope: InstallationScope, private readonly lifecycle: GuildLifecycleService,
    private readonly model: string, private readonly tasks = new DebateTaskService(), private readonly scoring = new DebateScoringPolicy(),
    private readonly audit = new DebateAudit(scope, lifecycle)) {
    invariant(/^[^\s\p{Cc}]{1,512}$/u.test(model), 'Invalid Debate model');
  }

  /** Propose exact topic, two participants, rubric, audience and retention without inferring anyone's consent. */
  async proposeSession(trusted: TrustedCallerContext, value: unknown): Promise<DebateSessionResponseDto> {
    const caller = this.caller(trusted), input = parseDebateProposal(value);
    invariant(caller.actorId !== input.opponentUserId, 'Invite a different participant');
    return this.orm.em.fork().transactional(async em => {
      invariant(await this.lifecycle.lockFeatureAdmission(em, this.scope, 'debates'), 'Debates admission is unavailable');
      const now = new Date(), existing = await em.findOne(DebateSession, { ...this.scope, sourceRequestId: caller.sourceRequestId, sourceOperationKey: `propose:${caller.actorId}` });
      if (existing) {
        const rubric = await em.findOneOrFail(RubricRevision, { ...this.scope, id: existing.rubricRevisionId });
        invariant(existing.topic === input.topic && existing.channelId === input.channelId && existing.invitedUserIds[1] === input.opponentUserId
          && existing.consentScope.retentionSeconds === input.retentionSeconds && !rubric.payloadPurgedAt
          && isDeepStrictEqual(readDebateRubric(rubric), input.rubric), 'Debate proposal replay mismatch');
        return this.sessionView(em, existing);
      }
      invariant(await em.count(DebateSession, { ...this.scope, state: { $nin: ['canceled', 'evaluated'] }, purgeAfter: { $gt: now } }) < 32, 'Active Debate limit reached');
      const config = await this.lifecycle.readPolicyConfig(em, this.scope);
      invariant(input.retentionSeconds <= config.retention.payloadDays * 86400, 'Debate retention exceeds approved policy');
      const purgeAfter = new Date(now.getTime() + input.retentionSeconds * 1000), rubric = new RubricRevision({ ...this.scope, createdAt: now,
        rubricId: randomUUID(), revision: 1, criteria: input.rubric.criteria.map(rule => ({ id: rule.id, description: rule.description, minimumScore: 0, maximumScore: rule.levels.length - 1 })),
        weights: Object.fromEntries(input.rubric.criteria.map(rule => [rule.id, rule.weight])),
        configurationVersions: { model: this.model, paired: String(input.rubric.paired), minimumConfidence: String(input.rubric.minimumConfidence),
          maximumPairDifference: String(input.rubric.maximumPairDifference), ...Object.fromEntries(input.rubric.criteria.map(rule => [`levels:${rule.id}`, JSON.stringify(rule.levels)])) },
        outcomeRules: { minimumWinningMargin: input.rubric.minimumWinningMargin, incompleteCoverage: 'uncertain' }, activatedAt: now, purgeAfter });
      const session = new DebateSession({ ...this.scope, createdAt: now, sourceRequestId: caller.sourceRequestId, sourceOperationKey: `propose:${caller.actorId}`,
        channelId: input.channelId, topic: input.topic, invitedUserIds: [caller.actorId, input.opponentUserId], scopeRevision: 1, rubricRevisionId: rubric.id,
        consentScope: { schemaVersion: 1, purpose: 'debate_evaluation', audienceChannelId: input.channelId, retentionSeconds: input.retentionSeconds,
          includeEdits: false, includeDeletedContent: false, submissionMode: 'explicit_text', assessmentModel: this.model }, purgeAfter });
      em.persist([rubric, session]);
      await this.audit.record(em, { operation: 'debates.proposal', outcome: 'intent', sessionId: session.id, recordId: session.id, revision: session.rowRevision,
        origin: { kind: 'user', userId: caller.actorId }, at: now, references: [{ owner: 'debates', recordId: rubric.id, revision: rubric.revision }] });
      await em.flush(); return this.sessionView(em, session);
    });
  }

  /** Each invited actor independently accepts the displayed exact scope; withdrawal works even while paused or disabled. */
  async recordConsent(trusted: TrustedCallerContext, value: unknown): Promise<DebateSessionResponseDto> {
    const caller = this.caller(trusted), input = parseDebateAction(value, ['scopeHash', 'accept']);
    invariant(typeof input.accept === 'boolean' && typeof input.scopeHash === 'string' && /^[a-f0-9]{64}$/.test(input.scopeHash), 'Invalid Debate consent');
    return this.orm.em.fork().transactional(async em => {
      await this.lifecycle.lockPrivacy(em, this.scope);
      const session = await this.session(em, input.sessionId, caller.actorId);
      invariant(input.scopeHash === debateScopeHash(session), 'Debate consent scope changed');
      const consent = await em.findOne(ParticipantConsent, { ...this.scope, sessionId: session.id, userId: caller.actorId, scopeRevision: session.scopeRevision }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const now = new Date();
      if (!input.accept) {
        if (consent && !consent.withdrawnAt) {
          consent.withdraw('participant_withdrawal', now);
          await this.audit.record(em, { operation: 'debates.consent_withdrawn', outcome: 'canceled', sessionId: session.id, recordId: consent.id,
            revision: consent.rowRevision, origin: { kind: 'user', userId: caller.actorId }, at: now });
        }
        await this.purgeSession(em, session, 'participant_withdrawal', now, { kind: 'user', userId: caller.actorId }); return this.sessionView(em, session);
      }
      invariant(await this.lifecycle.lockFeatureAdmission(em, this.scope, 'debates'), 'Debates admission is unavailable');
      this.retained(session, now); invariant(session.state === 'proposed', 'Consent is closed after the session starts');
      if (consent) invariant(!consent.withdrawnAt && consent.scopeHash === input.scopeHash, 'Withdrawn consent cannot be restored');
      else {
        const accepted = new ParticipantConsent({ ...this.scope, createdAt: now, sessionId: session.id, userId: caller.actorId, scopeRevision: session.scopeRevision,
          acceptedScope: session.consentScope, scopeHash: input.scopeHash, acceptedAt: now, sourceRequestId: caller.sourceRequestId, purgeAfter: session.purgeAfter });
        em.persist(accepted);
        await this.audit.record(em, { operation: 'debates.consent', outcome: 'succeeded', sessionId: session.id, recordId: accepted.id,
          revision: accepted.rowRevision, origin: { kind: 'user', userId: caller.actorId }, at: now });
      }
      await em.flush(); return this.sessionView(em, session);
    });
  }

  /** Start only after every exact invited participant has independently consented. */
  async startSession(trusted: TrustedCallerContext, value: unknown): Promise<DebateSessionResponseDto> {
    const caller = this.caller(trusted), input = parseDebateAction(value);
    return this.orm.em.fork().transactional(async em => {
      await this.admission(em); const session = await this.session(em, input.sessionId, caller.actorId), now = new Date();
      this.retained(session, now); const users = await this.consented(em, session, now);
      if (session.state !== 'active') {
        session.start(users, session.scopeRevision, now);
        await this.audit.record(em, { operation: 'debates.started', outcome: 'succeeded', sessionId: session.id, recordId: session.id,
          revision: session.rowRevision, origin: { kind: 'user', userId: caller.actorId }, at: now });
      }
      return this.sessionView(em, session);
    });
  }

  /** Capture only this authenticated participant's explicit submitted text; no channel history or other author's text is fetched. */
  async appendEntry(trusted: TrustedCallerContext, value: unknown): Promise<{ entryId: string; sequence: number }> {
    const caller = this.caller(trusted), input = parseDebateAction(value, ['text']);
    invariant(typeof input.text === 'string' && input.text.trim().length >= 1 && input.text.length <= 1000 && !input.text.includes('\0'), 'Invalid Debate submission');
    const text = input.text;
    return this.orm.em.fork().transactional(async em => {
      await this.admission(em); const session = await this.session(em, input.sessionId, caller.actorId), now = new Date();
      this.retained(session, now); await this.consented(em, session, now); invariant(session.state === 'active', 'Debate transcript is not accepting submissions');
      const sourceEventKey = `submission:${caller.sourceRequestId}`, previous = await em.findOne(TranscriptEntry, { ...this.scope, sessionId: session.id, sourceEventKey });
      if (previous) {
        invariant(previous.authorId === caller.actorId && previous.content?.text === text, 'Debate submission replay mismatch'); return { entryId: previous.id, sequence: previous.sequence };
      }
      const entries = await em.find(TranscriptEntry, { ...this.scope, sessionId: session.id }, { orderBy: { sequence: 'asc' }, limit: 21 });
      invariant(entries.length < 20 && Buffer.byteLength(JSON.stringify(entries.map(entry => entry.content?.text))) + Buffer.byteLength(text) <= 12000, 'Debate transcript limit reached');
      const entry = new TranscriptEntry({ ...this.scope, createdAt: now, sessionId: session.id, sequence: entries.length + 1, kind: 'submission', sourceEventKey,
        messageId: null, authorId: caller.actorId, sourceCreatedAt: now, sourceEditedAt: null, capturedAt: now,
        content: { schemaVersion: 1, text, contentAccess: 'available' }, artifactIds: [], contentHash: createHash('sha256').update(text).digest('hex'),
        coverage: { complete: true, reasons: [] }, purgeAfter: session.purgeAfter }); em.persist(entry);
      await this.audit.record(em, { operation: 'debates.submission', outcome: 'succeeded', sessionId: session.id, recordId: entry.id,
        revision: 0, origin: { kind: 'user', userId: caller.actorId }, at: now });
      return { entryId: entry.id, sequence: entry.sequence };
    });
  }

  /** Freeze all declared submissions once, then register the required original/reversed evaluations in that same transaction. */
  async freezeTranscript(trusted: TrustedCallerContext, value: unknown): Promise<DebateSessionResponseDto> {
    const caller = this.caller(trusted), input = parseDebateAction(value);
    return this.orm.em.fork().transactional(async em => {
      const admission = await this.admission(em); const session = await this.session(em, input.sessionId, caller.actorId), now = new Date();
      this.retained(session, now); await this.consented(em, session, now);
      if (session.state === 'evaluating' || session.state === 'evaluated') return this.sessionView(em, session);
      invariant(session.state === 'active', 'Debate must be active before freezing');
      const rubric = await em.findOneOrFail(RubricRevision, { ...this.scope, id: session.rubricRevisionId });
      const entries = await this.entries(em, session), contentHash = transcriptHash(entries);
      const snapshot = new TranscriptSnapshot({ ...this.scope, createdAt: now, sessionId: session.id, revision: 1, orderedEntryIds: entries.map(entry => entry.id), contentHash,
        declaredCoverage: { firstSequence: 1, lastSequence: entries.length, complete: true }, gaps: [], frozenAt: now, purgeAfter: session.purgeAfter, earliestEntryExpiry: session.purgeAfter });
      const frozen: FrozenDebateInput = { sessionId: session.id, snapshotId: snapshot.id, contentHash, rubricId: rubric.id,
        participantIds: session.invitedUserIds, topic: session.topic!, entries, rubric: readDebateRubric(rubric), model: rubric.configurationVersions!.model! };
      this.scoring.validate(frozen); session.freeze(snapshot.id, now); em.persist(snapshot);
      const variants: EvaluationVariant[] = frozen.rubric.paired ? ['original', 'reversed'] : ['original'];
      const expected: Partial<Record<EvaluationVariant, string>> = {};
      for (const variant of variants) expected[variant] = this.tasks.register(em, { ...this.scope, sessionId: session.id, variant,
        consentScopeHash: debateScopeHash(session),
        snapshotId: snapshot.id, rubricId: rubric.id, cancellationGeneration: session.cancellationGeneration, scopeRevision: session.scopeRevision,
        safetyRevision: admission.safetyRevision, model: frozen.model, payload: { schemaVersion: 1, kind: 'debates.assess', input: this.scoring.prepare(frozen, variant) },
        now, deadline: new Date(Math.min(now.getTime() + 120000, session.purgeAfter.getTime())), purgeAfter: session.purgeAfter });
      session.expectEvaluationTasks(expected, now);
      await this.audit.record(em, { operation: 'debates.evaluation_requested', outcome: 'intent', sessionId: session.id, recordId: snapshot.id,
        revision: snapshot.revision, origin: { kind: 'user', userId: caller.actorId }, at: now,
        references: Object.values(expected).map(recordId => ({ owner: 'jobs', recordId, revision: null })) });
      return this.sessionView(em, session);
    });
  }

  /** Recover abandoned work and accept stored result references in bounded independent owner transactions. */
  async runMaintenance(): Promise<void> {
    await this.tasks.recover(this.orm.em.fork());
    const pending = await this.tasks.pending(this.orm.em.fork(), this.scope);
    for (const sessionId of new Set(pending.map(row => row.sessionId))) await this.acceptEvaluation(sessionId);
  }

  /** Accept both required variants once under exact retained transcript, rubric, consent and safety locks. */
  async acceptEvaluation(sessionId: string): Promise<boolean> {
    return this.orm.em.fork().transactional(async em => {
      const admission = await this.lifecycle.lockFeatureAdmission(em, this.scope, 'debates', 'continuation');
      const session = await em.findOne(DebateSession, { ...this.scope, id: sessionId }, { lockMode: LockMode.PESSIMISTIC_WRITE }); if (!session) return false;
      const results: StoredDebateCompletion[] = [];
      for (const taskId of Object.values(session.expectedEvaluationTasks)) { const result = await this.tasks.read(em, this.scope, taskId, session.id); if (result) results.push(result); }
      if (!results.length || results.every(result => result.acknowledged)) return false;
      const now = new Date();
      if (!admission || session.state !== 'evaluating' || session.payloadPurgedAt || session.purgeAfter <= now
        || !await this.hasConsent(em, session, now)) {
        await this.discardResults(em, session, results, now); return false;
      }
      if (results.length !== Object.keys(session.expectedEvaluationTasks).length) return false;
      const frozen = await this.frozen(em, session, now);
      if (!frozen || results.some(result => result.acknowledged || result.snapshotId !== frozen.snapshotId || result.rubricId !== frozen.rubricId
        || result.cancellationGeneration !== session.cancellationGeneration || result.scopeRevision !== session.scopeRevision || result.safetyRevision !== admission.safetyRevision
        || result.model !== frozen.model || session.expectedEvaluationTasks[result.variant] !== result.taskId)) {
        await this.discardResults(em, session, results, now); return false;
      }
      const assessments: Partial<Record<EvaluationVariant, AssessmentResult>> = {};
      for (const result of results) if (result.outcome === 'success' && result.currentAttempt && result.payload && result.deadline > now) assessments[result.variant] = result.payload as unknown as AssessmentResult;
      const scores = this.scoring.evaluate(frozen, assessments);
      const evaluation = new DebateEvaluation({ ...this.scope, createdAt: now, acceptanceOperationKey: `${session.id}:${frozen.snapshotId}`, sessionId: session.id,
        transcriptSnapshotId: frozen.snapshotId, rubricRevisionId: frozen.rubricId, acceptedResults: Object.fromEntries(results.map(result => [result.variant, result.resultId])),
        ...scores, acceptedAt: now, publicationDestination: { channelId: session.channelId, allowedMentionUserIds: [] }, purgeAfter: session.purgeAfter });
      em.persist(evaluation); session.acceptEvaluation({ evaluationId: evaluation.id, transcriptId: frozen.snapshotId, rubricRevisionId: frozen.rubricId,
        completedTaskIds: results.map(result => result.taskId), at: now });
      for (const result of results) await this.tasks.acknowledge(em, this.scope, result, 'accepted', now);
      await this.audit.record(em, { operation: 'debates.evaluation', outcome: scores.outcome.kind === 'uncertain' ? 'unknown' : 'succeeded',
        sessionId: session.id, recordId: evaluation.id, revision: evaluation.rowRevision, at: now,
        references: results.map(result => ({ owner: 'jobs', recordId: result.resultId, revision: null })) });
      return true;
    });
  }

  /** Either participant can cancel future processing and erase all retained content, even after feature admission closes. */
  async cancelSession(trusted: TrustedCallerContext, value: unknown): Promise<DebateSessionResponseDto> {
    const caller = this.caller(trusted), input = parseDebateAction(value);
    return this.orm.em.fork().transactional(async em => { await this.lifecycle.lockPrivacy(em, this.scope);
      const session = await this.session(em, input.sessionId, caller.actorId);
      await this.purgeSession(em, session, 'participant_cancellation', new Date(), { kind: 'user', userId: caller.actorId }); return this.sessionView(em, session); });
  }

  /** Only an invited participant can inspect the exact proposal and current lifecycle metadata. */
  async readSession(trusted: TrustedCallerContext, value: unknown): Promise<DebateSessionResponseDto> {
    const caller = this.caller(trusted), input = parseDebateAction(value);
    return this.orm.em.fork().transactional(async em => { await this.lifecycle.lockPrivacy(em, this.scope); return this.sessionView(em, await this.session(em, input.sessionId, caller.actorId)); });
  }

  /** Read accepted scores only while both original participants still consent and their retention is active. */
  async readResult(trusted: TrustedCallerContext, value: unknown): Promise<DebateResultResponseDto> {
    const caller = this.caller(trusted), input = parseDebateAction(value);
    return this.orm.em.fork().transactional(async em => { await this.admission(em, 'continuation'); const session = await this.session(em, input.sessionId, caller.actorId);
      invariant(await this.publicationEligible(em, session, new Date()), 'Debate result is unavailable');
      return debateResultView(await em.findOneOrFail(DebateEvaluation, { ...this.scope, id: session.acceptedEvaluationId! })); });
  }

  /** Publication owners call this after the installation/session locks and before copying outbound content. */
  async publicationEligible(em: EntityManager, session: DebateSession, at: Date): Promise<boolean> {
    const admission = await this.lifecycle.lockFeatureAdmission(em, this.scope, 'debates', 'continuation');
    if (!admission || session.state !== 'evaluated' || session.payloadPurgedAt || session.purgeAfter <= at || !session.acceptedEvaluationId
      || !await this.hasConsent(em, session, at) || !await this.frozen(em, session, at)) return false;
    const evaluation = await em.findOneOrFail(DebateEvaluation, { ...this.scope, id: session.acceptedEvaluationId });
    for (const [variant, taskId] of Object.entries(session.expectedEvaluationTasks)) {
      const completion = await this.tasks.read(em, this.scope, taskId, session.id);
      if (!completion?.acknowledged || completion.safetyRevision !== admission.safetyRevision
        || completion.snapshotId !== session.frozenTranscriptId || completion.rubricId !== session.rubricRevisionId
        || evaluation.acceptedResults[variant as EvaluationVariant] !== completion.resultId) return false;
    }
    return true;
  }

  /** Expired sessions are invalidated and purged in batches; consent and delivery identity survive for reconciliation. */
  async runRetention(em: EntityManager, at = new Date()): Promise<number> {
    invariant(em.isInTransaction(), 'Debate retention requires owner transaction'); await this.lifecycle.lockPrivacy(em, this.scope);
    const rows = await em.find(DebateSession, { ...this.scope, payloadPurgedAt: null, purgeAfter: { $lte: at } }, { limit: 10, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const session of rows) await this.purgeSession(em, session, 'retention', at);
    await em.flush(); await this.purgeMetadata(em, at); return rows.length;
  }

  /** Removal erases bounded session graphs and explicitly reports retained consent/publication metadata. */
  async cleanupForRemoval(em: EntityManager, at = new Date()): Promise<{ disposition: 'pending' | 'retained' | 'complete'; reasonCode: string | null }> {
    invariant(em.isInTransaction(), 'Debate removal requires owner transaction'); await this.lifecycle.lockPrivacy(em, this.scope);
    const rows = await em.find(DebateSession, { ...this.scope, payloadPurgedAt: null }, { limit: 10, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const session of rows) await this.purgeSession(em, session, 'installation_removal', at); await em.flush();
    if (await em.count(DebateSession, { ...this.scope, payloadPurgedAt: null })) return { disposition: 'pending', reasonCode: 'debate_payload_cleanup' };
    return await em.count(DebateSession, this.scope) ? { disposition: 'retained', reasonCode: 'debate_consent_publication_metadata' } : { disposition: 'complete', reasonCode: null };
  }

  /** Remove expired consent/source metadata only after its task accounting and publication outcome are settled. */
  private async purgeMetadata(em: EntityManager, at: Date): Promise<void> {
    const config = await this.lifecycle.readPolicyConfig(em, this.scope), cutoff = new Date(at.getTime() - config.retention.metadataDays * 86400000);
    const sessions = await em.find(DebateSession, { ...this.scope, payloadPurgedAt: { $ne: null }, createdAt: { $lte: cutoff } },
      { limit: 10, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const session of sessions) {
      if (await em.count(DebateEvaluation, { ...this.scope, sessionId: session.id, publicationState: { $in: ['claimed', 'unknown'] } })) continue;
      if (!await this.tasks.purgeMetadata(em, this.scope, session.id, cutoff, at)) continue;
      for (const table of ['debate_evaluation', 'transcript_snapshot', 'transcript_entry', 'participant_consent']) {
        await em.execute(`delete from ${table} where installation_id=? and guild_id=? and session_id=?`, [this.scope.installationId, this.scope.guildId, session.id]);
      }
      await em.execute('delete from debate_session where installation_id=? and guild_id=? and id=?', [this.scope.installationId, this.scope.guildId, session.id]);
      await em.execute(`delete from rubric_revision r where installation_id=? and guild_id=? and id=?
        and not exists(select 1 from debate_session s where s.rubric_revision_id=r.id)`, [this.scope.installationId, this.scope.guildId, session.rubricRevisionId]);
    }
  }

  /** Preserve one lock order across consent, submission, evaluation and publication. */
  private async admission(em: EntityManager, purpose: 'admission' | 'continuation' = 'admission'): Promise<{ safetyRevision: number }> {
    const value = await this.lifecycle.lockFeatureAdmission(em, this.scope, 'debates', purpose); invariant(value, 'Debates admission is unavailable'); return value;
  }
  /** Bind trusted ingress identity before any session lookup, including privacy requests. */
  private caller(value: TrustedCallerContext): TrustedCallerContext {
    invariant(value.installationId === this.scope.installationId && value.guildId === this.scope.guildId, 'Wrong Debate installation'); assertDiscordId(value.actorId);
    invariant(typeof value.sourceRequestId === 'string' && value.sourceRequestId.length >= 1 && value.sourceRequestId.length <= 200, 'Invalid Debate request identity'); return Object.freeze({ ...value });
  }
  /** A session lock serializes every participant decision and its dependent content writes. */
  private async session(em: EntityManager, id: string, actorId: string): Promise<DebateSession> {
    const session = await em.findOneOrFail(DebateSession, { ...this.scope, id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    invariant(session.invitedUserIds.includes(actorId), 'Debate participant required'); return session;
  }
  /** Explicit expiry checks protect reads without waiting for maintenance. */
  private retained(session: DebateSession, at: Date): void { invariant(session.state !== 'canceled' && !session.payloadPurgedAt && session.purgeAfter > at, 'Debate content is unavailable'); }
  /** Require every immutable scope/hash to remain accepted, unwithdrawn and unexpired. */
  private async consented(em: EntityManager, session: DebateSession, at: Date): Promise<string[]> {
    invariant(await this.hasConsent(em, session, at), 'Every Debate participant must consent'); return [...session.invitedUserIds];
  }
  /** Query consent under the already-held session lock so withdrawal cannot race a content write. */
  private async hasConsent(em: EntityManager, session: DebateSession, at: Date): Promise<boolean> {
    const rows = await em.find(ParticipantConsent, { ...this.scope, sessionId: session.id, scopeRevision: session.scopeRevision });
    return session.invitedUserIds.every(id => rows.some(row => row.userId === id && !row.withdrawnAt && row.purgeAfter > at
      && row.scopeHash === debateScopeHash(session) && isDeepStrictEqual(row.acceptedScope, session.consentScope)));
  }
  /** Read at most the declared twenty explicit submissions, retaining their exact order and attribution. */
  private async entries(em: EntityManager, session: DebateSession): Promise<FrozenDebateEntry[]> {
    const rows = await em.find(TranscriptEntry, { ...this.scope, sessionId: session.id }, { orderBy: { sequence: 'asc' }, limit: 21 });
    invariant(rows.every(row => row.kind === 'submission' && row.authorId && !row.payloadPurgedAt && row.purgeAfter > new Date()
      && row.content?.contentAccess === 'available' && typeof row.content.text === 'string' && row.coverage.complete), 'Declared transcript is unavailable');
    return rows.map(row => ({ id: row.id, authorId: row.authorId!, sequence: row.sequence, text: row.content!.text! }));
  }
  /** Rebuild and verify the exact frozen selection before result acceptance or publication. */
  private async frozen(em: EntityManager, session: DebateSession, at: Date): Promise<FrozenDebateInput | null> {
    if (!session.frozenTranscriptId || !session.topic) return null;
    const snapshot = await em.findOne(TranscriptSnapshot, { ...this.scope, id: session.frozenTranscriptId, sessionId: session.id });
    const rubric = await em.findOne(RubricRevision, { ...this.scope, id: session.rubricRevisionId });
    if (!snapshot || snapshot.payloadPurgedAt || snapshot.purgeAfter <= at || !snapshot.declaredCoverage.complete || !snapshot.orderedEntryIds
      || !rubric || rubric.payloadPurgedAt || rubric.purgeAfter <= at || !rubric.configurationVersions) return null;
    try {
      const entries = await this.entries(em, session);
      if (!isDeepStrictEqual(entries.map(entry => entry.id), snapshot.orderedEntryIds)) return null;
      const input: FrozenDebateInput = { sessionId: session.id, snapshotId: snapshot.id, contentHash: snapshot.contentHash, rubricId: rubric.id,
        participantIds: session.invitedUserIds, topic: session.topic, entries, rubric: readDebateRubric(rubric), model: rubric.configurationVersions.model! };
      this.scoring.validate(input); return input;
    } catch { return null; }
  }
  /** Record each discarded immutable result and cancellation in the same transaction as its acknowledgment. */
  private async discardResults(em: EntityManager, session: DebateSession, results: StoredDebateCompletion[], at: Date): Promise<void> {
    for (const result of results) if (!result.acknowledged) {
      await this.tasks.acknowledge(em, this.scope, result, 'discarded', at);
      await this.audit.record(em, { operation: 'debates.result_discarded', outcome: 'discarded', sessionId: session.id,
        recordId: result.resultId, revision: 0, owner: 'jobs', at });
    }
    if (session.state === 'evaluating') {
      session.cancel(at);
      await this.audit.record(em, { operation: 'debates.canceled', outcome: 'canceled', sessionId: session.id,
        recordId: session.id, revision: session.rowRevision, at });
    }
  }
  /** Invalidate first, then erase every copied payload while preserving minimal consent and unknown-send identity. */
  private async purgeSession(em: EntityManager, session: DebateSession, reason: string, at: Date, origin?: AuditOrigin): Promise<void> {
    if (session.state !== 'canceled') {
      session.cancel(at);
      await this.audit.record(em, { operation: 'debates.canceled', outcome: 'canceled', sessionId: session.id,
        recordId: session.id, revision: session.rowRevision, at, ...(origin ? { origin } : {}) });
    }
    await this.tasks.invalidate(em, this.scope, session.id, reason, at);
    const entries = await em.find(TranscriptEntry, { ...this.scope, sessionId: session.id }, { limit: 21 }); invariant(entries.length <= 20, 'Debate transcript bound exceeded');
    for (const entry of entries) entry.purgePayload(reason, at);
    const snapshots = await em.find(TranscriptSnapshot, { ...this.scope, sessionId: session.id }, { limit: 2 }); invariant(snapshots.length <= 1, 'Debate snapshot bound exceeded');
    for (const snapshot of snapshots) snapshot.purgePayload(reason, at);
    const evaluations = await em.find(DebateEvaluation, { ...this.scope, sessionId: session.id }, { limit: 2, lockMode: LockMode.PESSIMISTIC_WRITE }); invariant(evaluations.length <= 1, 'Debate evaluation bound exceeded');
    for (const evaluation of evaluations) {
      const state = evaluation.publicationState; evaluation.purgePayload(reason, at);
      if (state !== evaluation.publicationState) await this.audit.record(em, { operation: 'debates.publication',
        outcome: evaluation.publicationState === 'unknown' ? 'unknown' : 'canceled', sessionId: session.id,
        recordId: evaluation.id, revision: evaluation.rowRevision, at, ...(origin ? { origin } : {}) });
    }
    const rubric = await em.findOneOrFail(RubricRevision, { ...this.scope, id: session.rubricRevisionId }); rubric.purgePayload(reason, at);
    if (!session.payloadPurgedAt) {
      session.purgePayload(reason, at);
      await this.audit.record(em, { operation: `debates.purged.${reason}`, outcome: 'succeeded', sessionId: session.id,
        recordId: session.id, revision: session.rowRevision, at, ...(origin ? { origin } : {}) });
    }
  }
  /** Expose the full reviewable consent proposal only to a participant, without exposing transcript content. */
  private async sessionView(em: EntityManager, session: DebateSession): Promise<DebateSessionResponseDto> {
    const rubric = await em.findOneOrFail(RubricRevision, { ...this.scope, id: session.rubricRevisionId });
    const now = new Date(), retained = !session.payloadPurgedAt && session.purgeAfter > now;
    const rows = await em.find(ParticipantConsent, { ...this.scope, sessionId: session.id, withdrawnAt: null, purgeAfter: { $gt: now } });
    return { sessionId: session.id, state: session.state, revision: session.rowRevision, scopeHash: debateScopeHash(session), channelId: session.channelId,
      participantIds: [...session.invitedUserIds], topic: retained ? session.topic : null,
      rubric: retained && !rubric.payloadPurgedAt && rubric.purgeAfter > now ? readDebateRubric(rubric) : null,
      assessmentModel: session.consentScope.assessmentModel ?? '', consentedUserIds: rows.map(row => row.userId), transcriptId: session.frozenTranscriptId,
      evaluationId: session.acceptedEvaluationId, purgeAfter: session.purgeAfter.toISOString(), retentionSeconds: session.consentScope.retentionSeconds,
      payerUserId: session.invitedUserIds[0]!, processing: 'explicit_submissions_jev_scoring' };
  }
}

/** Immutable owner identities bind the separately displayed topic/rubric without depending on JSONB object key order. */
export function debateScopeHash(session: DebateSession): string {
  const scope = session.consentScope;
  return createHash('sha256').update(JSON.stringify([session.id, session.channelId, session.invitedUserIds, session.rubricRevisionId, session.scopeRevision,
    scope.purpose, scope.audienceChannelId, scope.retentionSeconds, scope.includeEdits, scope.includeDeletedContent, scope.submissionMode, scope.assessmentModel])).digest('hex');
}
/** Copy only accepted owner values; this DTO is never an input to evaluation acceptance. */
export function debateResultView(row: DebateEvaluation): DebateResultResponseDto {
  return { sessionId: row.sessionId, evaluationId: row.id, transcriptId: row.transcriptSnapshotId, outcome: copyJson(row.outcome), totals: copyJson(row.totals),
    scores: copyJson(row.criterionScores), limitations: copyJson(row.limitations), publicationState: row.publicationState, publicationMessageId: row.publicationMessageId };
}
