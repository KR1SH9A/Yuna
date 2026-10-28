/** Restricted Debate SQL is the worker's entire database interface; no direct transcript reads. */
import type { MikroORM } from '@mikro-orm/postgresql';
import { invariant } from '../db/entity-values.js';
import type { DebateWorkerClaim, DebatePreparedPayload, DebateTaskOutcome } from './debate-task.contracts.js';
export class DebateWorkerStore {
  /** Use only the separately configured least-privilege worker connection. */
  constructor(private readonly orm: MikroORM) {}
  /** Reserve a compatible attempt without disclosing its input. */
  async claimNext(executor: string, model: string): Promise<DebateWorkerClaim | null> {
    const rows = await this.orm.em.fork().execute<{ claim: DebateWorkerClaim | null }[]>('select public.yuna_debate_claim(?,?) as claim', [executor, model]); return rows[0]?.claim ?? null;
  }
  /** Recheck exact consent, transcript, rubric and safety at one-shot disclosure. */
  async releasePreparedInput(claim: DebateWorkerClaim): Promise<DebatePreparedPayload | null> {
    const rows = await this.orm.em.fork().execute<{ payload: DebatePreparedPayload | null }[]>('select public.yuna_debate_release(?,?,?,?) as payload', [claim.taskId, claim.attemptId, claim.generation, claim.executorId]); return rows[0]?.payload ?? null;
  }
  /** Persist dispatch intent only while every original consent remains current. */
  async recordProviderStart(claim: DebateWorkerClaim): Promise<boolean> {
    const rows = await this.orm.em.fork().execute<{ started: boolean }[]>('select public.yuna_debate_start(?,?,?,?) as started', [claim.taskId, claim.attemptId, claim.generation, claim.executorId]); return rows[0]?.started ?? false;
  }
  /** A stale result can settle actual cost but cannot resurrect withdrawn work. */
  async recordResult(claim: DebateWorkerClaim, result: DebateTaskOutcome): Promise<'stored' | 'stale'> {
    invariant(/^[a-z0-9_.-]{1,120}$/.test(result.reason) && Buffer.byteLength(JSON.stringify(result)) <= 65536, 'Invalid Debate result envelope');
    const rows = await this.orm.em.fork().execute<{ stored: boolean }[]>('select public.yuna_debate_finish(?,?,?,?,?::jsonb) as stored', [claim.taskId, claim.attemptId, claim.generation, claim.executorId, JSON.stringify(result)]); return rows[0]?.stored ? 'stored' : 'stale';
  }
}
