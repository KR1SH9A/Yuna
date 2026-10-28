/** Publish accepted Debate results once, then reconcile ambiguity without resending withdrawn or unknown work. */
import { createHash } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { GuildLifecycleService, type InstallationScope } from '../administration/guild-lifecycle.service.js';
import { DebateService } from './debate.service.js';
import { DebateEvaluation } from './entities/debate-evaluation.entity.js';
import { DebateSession } from './entities/debate-session.entity.js';
import type { DebatePublicationOutcome, DebatePublicationTransport } from './contracts.js';
import { DebateAudit } from './debate-audit.js';
import type { EntityManager } from '@mikro-orm/postgresql';

export class DebatePublicationService {
  private readonly active = new Set<string>();
  private cursor: string | undefined;
  /** Use the same owner eligibility check for publication that protects participant result reads. */
  constructor(private readonly orm: MikroORM, private readonly scope: InstallationScope, private readonly lifecycle: GuildLifecycleService,
    private readonly debates: DebateService, private readonly transport: DebatePublicationTransport,
    private readonly audit = new DebateAudit(scope, lifecycle)) {}

  /** Bound new sends separately from uncertain recovery so one slow lookup cannot resend or starve everything. */
  async runMaintenance(signal: AbortSignal): Promise<void> {
    const rows = await this.orm.em.fork().find(DebateEvaluation, { ...this.scope, publicationState: 'pending' }, { limit: 10, orderBy: { acceptedAt: 'asc' } });
    for (const row of rows) { if (signal.aborted) return; await this.dispatch(row.id, signal); }
    const recovery = await this.orm.em.fork().find(DebateEvaluation, { ...this.scope, publicationState: { $in: ['claimed', 'unknown'] },
      ...(this.cursor ? { id: { $gt: this.cursor } } : {}) }, { limit: 5, orderBy: { id: 'asc' } });
    this.cursor = recovery.length === 5 ? recovery.at(-1)!.id : undefined;
    for (const row of recovery) { if (signal.aborted) return; await this.reconcile(row.id, signal); }
  }

  /** Check current destination facts outside transactions, then serialize consent and one committed send claim. */
  async dispatch(id: string, signal: AbortSignal): Promise<void> {
    if (this.active.has(id) || signal.aborted) return; this.active.add(id);
    try {
      const initial = await this.orm.em.fork().findOne(DebateEvaluation, { ...this.scope, id, publicationState: 'pending' }); if (!initial) return;
      let remote: { allowed: boolean; observedAt: Date };
      try { remote = await this.transport.prepare({ guildId: this.scope.guildId, channelId: initial.publicationDestination.channelId }, signal); }
      catch { return; }
      if (signal.aborted) return;
      const claim = await this.orm.em.fork().transactional(async em => {
        const admission = await this.lifecycle.lockFeatureAdmission(em, this.scope, 'debates', 'continuation');
        const session = await em.findOne(DebateSession, { ...this.scope, id: initial.sessionId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        const row = await em.findOne(DebateEvaluation, { ...this.scope, id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!row || row.publicationState !== 'pending') return null;
        const now = new Date(), age = now.getTime() - remote.observedAt.getTime();
        // Missing or aged observations authorize neither a send nor a definitive cancellation; maintenance can refresh them.
        if (!Number.isFinite(age) || age < 0 || age > 5000) return null;
        if (!admission || !session || session.acceptedEvaluationId !== row.id || !remote.allowed
          || row.payloadPurgedAt || row.purgeAfter <= now || !row.outcome || !await this.debates.publicationEligible(em, session, now)) {
          row.cancelPublication(now); await this.auditState(em, row, now); return null;
        }
        const content = publicationContent(row), contentHash = createHash('sha256').update(content).digest('hex');
        const nonce = createHash('sha256').update(`debate:${row.id}`).digest('hex').slice(0, 24);
        const deadline = new Date(Math.min(now.getTime() + 30000, row.purgeAfter.getTime()));
        const generation = row.claimPublication({ expectedGeneration: row.publicationAttempt?.generation ?? 0, executorId: 'bot-debate-publication',
          nonce, requestFingerprint: contentHash, leaseUntil: deadline, at: now }); row.markPublicationSent(generation, now);
        await this.auditState(em, row, now);
        return { generation, payload: { guildId: this.scope.guildId, channelId: row.publicationDestination.channelId, evaluationId: row.id, content, nonce, contentHash, deadline } };
      });
      if (!claim) return;
      let outcome: DebatePublicationOutcome;
      try { outcome = await this.transport.send(claim.payload, signal); }
      catch { outcome = { classification: 'unknown', code: 'transport_failure' }; }
      await this.orm.em.fork().transactional(async em => {
        await this.lifecycle.lockPrivacy(em, this.scope);
        const row = await em.findOne(DebateEvaluation, { ...this.scope, id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!row || !['claimed', 'unknown'].includes(row.publicationState) || row.publicationAttempt?.generation !== claim.generation) return;
        const now = new Date();
        if (outcome.classification === 'confirmed') row.recordPublication(claim.generation, outcome.messageId, now);
        else if (outcome.classification === 'rejected') row.recordPublicationRejection(claim.generation, safeCode(outcome.code), now);
        else row.recordPublicationUncertainty(claim.generation, safeCode(outcome.code), now);
        await this.auditState(em, row, now);
      });
    } finally { this.active.delete(id); }
  }

  /** Positive matching evidence can resolve a lost send after withdrawal; no content is sent or reconstructed here. */
  async reconcile(id: string, signal: AbortSignal): Promise<void> {
    if (this.active.has(id) || signal.aborted) return;
    const candidate = await this.orm.em.fork().transactional(async em => {
      await this.lifecycle.lockPrivacy(em, this.scope);
      const row = await em.findOne(DebateEvaluation, { ...this.scope, id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (this.active.has(id) || !row?.publicationAttempt) return null;
      const now = new Date(), attempt = row.publicationAttempt;
      if (row.publicationState === 'claimed') {
        if (Date.parse(attempt.leaseUntil) > now.getTime()) return null;
        row.recordPublicationUncertainty(attempt.generation, 'interrupted_publication', now);
        await this.auditState(em, row, now);
      }
      if (row.publicationState !== 'unknown') return null;
      return { guildId: this.scope.guildId, channelId: row.publicationDestination.channelId, evaluationId: row.id,
        nonce: attempt.nonce, contentHash: attempt.requestFingerprint, generation: attempt.generation };
    });
    if (!candidate || signal.aborted) return;
    let messageId: string | null; try { messageId = await this.transport.reconcile(candidate, signal); } catch { return; }
    if (!messageId) return;
    await this.orm.em.fork().transactional(async em => {
      await this.lifecycle.lockPrivacy(em, this.scope);
      const row = await em.findOne(DebateEvaluation, { ...this.scope, id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (row?.publicationState === 'unknown' && row.publicationAttempt?.generation === candidate.generation) {
        const now = new Date(); row.recordPublication(candidate.generation, messageId!, now); await this.auditState(em, row, now);
      }
    });
  }

  /** Persist intent and observed outcomes with owner references in the same transaction as the delivery state. */
  private async auditState(em: EntityManager, row: DebateEvaluation, at: Date): Promise<void> {
    await this.audit.record(em, { operation: 'debates.publication', sessionId: row.sessionId, recordId: row.id, revision: row.rowRevision, at,
      outcome: row.publicationState === 'claimed' ? 'intent' : row.publicationState === 'published' ? 'succeeded'
        : row.publicationState === 'unknown' ? 'unknown' : row.publicationState === 'canceled' ? 'canceled' : 'failed' });
  }
}

/** Publish code-owned totals and limitations only; raw submissions and invented model explanations never leave through this projection. */
function publicationContent(row: DebateEvaluation): string {
  const outcome = row.outcome?.kind === 'winner' ? `Higher rubric total: user ${row.outcome.userId}` : row.outcome?.kind === 'tie' ? 'Outcome: tie' : 'Outcome: insufficient or uncertain evidence';
  const totals = Object.entries(row.totals ?? {}).map(([id, total]) => `User ${id}: ${total}`).join('\n');
  return `Debate ${row.sessionId}\n${outcome}\n${totals}\nEvaluation covers only the consented explicit submissions. Scores confer no permissions or moderation consequences.\nLimitations: ${(row.limitations ?? []).join(', ')}`.slice(0, 1900);
}
/** Provider/transport exception text is never persisted as a reason code. */
function safeCode(value: string): string { return /^[a-z0-9_.-]{1,120}$/.test(value) ? value : 'transport_failure'; }
