/** Route one consented frozen Debate task to Jev, with no workflow choices or direct business reads. */
import { JevError, type JevService } from '../../src/ai/jev/jev.service.js';
import type { DebateWorkerStore } from '../../src/platform/jobs/debate-worker.store.js';
import type { DebateTaskOutcome } from '../../src/platform/jobs/debate-task.contracts.js';
export class DebateTaskHandlers {
  /** Provider/model selection comes from composition, never the stored transcript. */
  constructor(private readonly store: Pick<DebateWorkerStore, 'claimNext' | 'releasePreparedInput' | 'recordProviderStart' | 'recordResult'>,
    private readonly jev: Pick<JevService, 'assessQuestions'>, private readonly executorId: string, private readonly model: string, private readonly timeoutMs: number) {}
  /** A committed claim permits one provider call; failed result persistence never repeats that call. */
  async runOne(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const claim = await this.store.claimNext(this.executorId, this.model); if (!claim) return false;
    /** Reserve a small interval for persisting the provider outcome before the lease expires. */
    const remaining = () => Math.min(Date.parse(claim.deadline), Date.parse(claim.leaseUntil)) - Date.now() - 500;
    if (remaining() <= 0 || signal.aborted) { await this.store.recordResult(claim, { outcome: 'failure', reason: 'cancelled_before_release' }); return true; }
    const prepared = await this.store.releasePreparedInput(claim);
    if (!prepared || prepared.kind !== 'debates.assess' || claim.kind !== 'debates.assess' || signal.aborted || !await this.store.recordProviderStart(claim)) {
      await this.store.recordResult(claim, { outcome: 'failure', reason: 'disclosure_denied' }); return true;
    }
    const budget = remaining();
    if (budget <= 0 || signal.aborted) { await this.store.recordResult(claim, { outcome: 'failure', reason: 'cancelled_before_provider' }); return true; }
    let outcome: DebateTaskOutcome;
    try {
      const result = await this.jev.assessQuestions(prepared.input, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(budget, this.timeoutMs)))]));
      outcome = { outcome: 'success', reason: 'debate_assessment_completed', payload: result, providerRequestId: result.providerRequestId,
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, totalTokens: result.totalTokens, costUsd: result.costUsd } };
    } catch (error) { outcome = { outcome: error instanceof JevError && !error.costMayHaveBeenIncurred ? 'failure' : 'uncertain', reason: error instanceof JevError ? error.code : 'provider_failure' }; }
    await this.store.recordResult(claim, outcome); return true;
  }
}
