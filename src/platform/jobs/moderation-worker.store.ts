/** Restricted SQL is the worker's complete moderation persistence interface; no business table grants. */
import type { MikroORM } from '@mikro-orm/postgresql';
import { invariant } from '../db/entity-values.js';
import type { ModerationPreparedPayload, ModerationTaskKind, ModerationTaskOutcome, ModerationWorkerClaim } from './moderation-task.contracts.js';

export class ModerationWorkerStore {
  /** Keep one worker database boundary for explicitly registered moderation capabilities. */
  constructor(private readonly orm: MikroORM) {}

  /** Reserve one compatible attempt; its body remains withheld until release succeeds. */
  async claimNext(executorId: string, kind: ModerationTaskKind, model: string): Promise<ModerationWorkerClaim | null> {
    const rows = await this.orm.em.fork().execute<{ claim: ModerationWorkerClaim | null }[]>(
      'select public.yuna_moderation_claim(?,?,?) as claim', [executorId, kind, model]);
    return rows[0]?.claim ?? null;
  }
  /** One-shot disclosure rechecks retained evidence and current installation/policy/safety under locks. */
  async releasePreparedInput(claim: ModerationWorkerClaim): Promise<ModerationPreparedPayload | null> {
    const rows = await this.orm.em.fork().execute<{ payload: ModerationPreparedPayload | null }[]>(
      'select public.yuna_moderation_release(?,?,?,?) as payload', [claim.taskId, claim.attemptId, claim.generation, claim.executorId]);
    return rows[0]?.payload ?? null;
  }
  /** Persist dispatch intent immediately before provider I/O; replay cannot dispatch a second request. */
  async recordProviderStart(claim: ModerationWorkerClaim): Promise<boolean> {
    const rows = await this.orm.em.fork().execute<{ started: boolean }[]>(
      'select public.yuna_moderation_start(?,?,?,?) as started', [claim.taskId, claim.attemptId, claim.generation, claim.executorId]);
    return rows[0]?.started ?? false;
  }
  /** Store one bounded result or late accounting evidence without resurrecting invalidated work. */
  async recordResult(claim: ModerationWorkerClaim, outcome: ModerationTaskOutcome): Promise<'stored' | 'stale'> {
    invariant(/^[a-z0-9_.-]{1,120}$/.test(outcome.reason), 'Outcome requires a bounded reason code');
    invariant(Buffer.byteLength(JSON.stringify(outcome), 'utf8') <= 64 * 1024, 'Outcome exceeds storage boundary');
    const rows = await this.orm.em.fork().execute<{ stored: boolean }[]>(
      'select public.yuna_moderation_finish(?,?,?,?,?::jsonb) as stored',
      [claim.taskId, claim.attemptId, claim.generation, claim.executorId, JSON.stringify(outcome)]);
    return rows[0]?.stored ? 'stored' : 'stale';
  }
}
