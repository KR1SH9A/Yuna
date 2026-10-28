/** Expose only restricted database worker entry points for claim, input disclosure, start and completion. */
import type { MikroORM } from '@mikro-orm/postgresql';
import type { ReplyGenerationInput } from '../../ai/contracts/generation.contracts.js';
import { invariant } from '../db/entity-values.js';
import type { ConversationTaskOutcome, WorkerClaim } from './conversation-task.contracts.js';

export type { ConversationTaskOutcome, WorkerClaim } from './conversation-task.contracts.js';

/** Restricted SQL functions are the worker's entire database surface; no business metadata. */
export class WorkerTaskStore {
  /** Keep the worker connection private; all workflow access goes through restricted SQL entry points. */
  constructor(private readonly orm: MikroORM) {}

  /** Claim one compatible task without revealing its input or bypassing the daily cap. */
  async claimNext(executorId: string, model: string): Promise<WorkerClaim | null> {
    const rows = await this.orm.em.fork().execute<{ claim: WorkerClaim | null }[]>(
      'select public.yuna_conversation_claim(?, ?) as claim', [executorId, model],
    );
    return rows[0]?.claim ?? null;
  }

  /** Recheck live source/installation gates and disclose the immutable selected input once. */
  async releasePreparedInput(claim: WorkerClaim): Promise<ReplyGenerationInput | null> {
    const rows = await this.orm.em.fork().execute<{ payload: ReplyGenerationInput | null }[]>(
      'select public.yuna_conversation_release(?, ?, ?, ?) as payload',
      [claim.taskId, claim.attemptId, claim.generation, claim.executorId],
    );
    return rows[0]?.payload ?? null;
  }

  /** Persist dispatch intent before the external request; its absence proves no dispatch. */
  async recordProviderStart(claim: WorkerClaim): Promise<boolean> {
    const rows = await this.orm.em.fork().execute<{ started: boolean }[]>(
      'select public.yuna_conversation_start(?, ?, ?, ?) as started',
      [claim.taskId, claim.attemptId, claim.generation, claim.executorId],
    );
    return rows[0]?.started ?? false;
  }

  /** Preserve known attempt usage even when expiry or cancellation rejects its output. */
  async recordResult(claim: WorkerClaim, outcome: ConversationTaskOutcome): Promise<'stored' | 'stale'> {
    invariant(outcome.reason.length > 0 && outcome.reason.length <= 256, 'Task outcome requires a bounded reason');
    const rows = await this.orm.em.fork().execute<{ stored: boolean }[]>(
      'select public.yuna_conversation_finish(?, ?, ?, ?, ?::jsonb) as stored',
      [claim.taskId, claim.attemptId, claim.generation, claim.executorId, JSON.stringify(outcome)],
    );
    return rows[0]?.stored ? 'stored' : 'stale';
  }
}
