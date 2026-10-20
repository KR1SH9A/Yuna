import { LlmError, type LlmService } from '../../src/ai/llm/llm.service.js';
import type { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';

/** One accounted attempt; provider I/O runs only after a committed claim/disclosure/dispatch gate. */
export class AiTaskHandlers {
  constructor(private readonly store: Pick<WorkerTaskStore, 'claimNext' | 'releasePreparedInput' | 'recordProviderStart' | 'recordResult'>,
    private readonly llm: Pick<LlmService, 'generateReply'>,
    private readonly executorId: string, private readonly model: string, private readonly timeoutMs: number) {}

  /** Return whether a task was claimed. Errors persisting results never cause a provider retry. */
  async runOne(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const claim = await this.store.claimNext(this.executorId, this.model);
    if (!claim) return false;
    const remaining = Math.min(new Date(claim.deadline).getTime(), new Date(claim.leaseUntil).getTime()) - Date.now() - 500;
    if (remaining <= 0 || signal.aborted) {
      await this.store.recordResult(claim, { outcome: 'failure', reason: 'cancelled_before_release' });
      return true;
    }
    const input = await this.store.releasePreparedInput(claim);
    if (!input || signal.aborted || !await this.store.recordProviderStart(claim)) {
      await this.store.recordResult(claim, { outcome: 'failure', reason: 'disclosure_denied' });
      return true;
    }
    const dispatchRemaining = Math.min(new Date(claim.deadline).getTime(), new Date(claim.leaseUntil).getTime()) - Date.now() - 500;
    if (dispatchRemaining <= 0 || signal.aborted) {
      await this.store.recordResult(claim, { outcome: 'failure', reason: 'cancelled_before_provider' });
      return true;
    }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(dispatchRemaining, this.timeoutMs)))]);
    let result;
    try { result = await this.llm.generateReply(input, requestSignal); }
    catch (error) {
      await this.store.recordResult(claim, { outcome: error instanceof LlmError && !error.costMayHaveBeenIncurred ? 'failure' : 'uncertain',
        reason: error instanceof LlmError ? error.code : 'provider_failure' });
      console.warn(`ai-worker: generation ended (${error instanceof LlmError ? error.code : 'provider_failure'}).`);
      return true;
    }
    await this.store.recordResult(claim, { outcome: 'success', reason: 'generated', payload: result, providerRequestId: result.providerRequestId,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, totalTokens: result.totalTokens } });
    return true;
  }
}
