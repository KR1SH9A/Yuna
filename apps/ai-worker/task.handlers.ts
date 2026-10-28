/** Execute one durable conversation attempt and report provider time after its outcome is stored. */
import { LlmError, type LlmService } from '../../src/ai/llm/llm.service.js';
import type { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { noLatencyReporter, reportLatency, type LatencyReporter } from '../../src/platform/runtime/latency.js';

/** One accounted attempt; provider I/O runs only after a committed claim/disclosure/dispatch gate. */
export class AiTaskHandlers {
  /** Snapshot provider runtime options and injected execution dependencies without starting any task. */
  constructor(private readonly store: Pick<WorkerTaskStore, 'claimNext' | 'releasePreparedInput' | 'recordProviderStart' | 'recordResult'>,
    private readonly llm: Pick<LlmService, 'generateReply'>,
    private readonly executorId: string, private readonly model: string, private readonly timeoutMs: number,
    private readonly latency: LatencyReporter = noLatencyReporter) {}

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
    const providerStarted = performance.now();
    let result;
    try { result = await this.llm.generateReply(input, requestSignal); }
    catch (error) {
      const durationMs = performance.now() - providerStarted;
      const outcome = error instanceof LlmError && !error.costMayHaveBeenIncurred ? 'failure' : 'uncertain';
      await this.store.recordResult(claim, { outcome,
        reason: error instanceof LlmError ? error.code : 'provider_failure' });
      reportLatency(this.latency, { stage: 'provider', taskId: claim.taskId, durationMs, outcome });
      console.warn(`ai-worker: generation ended (${error instanceof LlmError ? error.code : 'provider_failure'}).`);
      return true;
    }
    const durationMs = performance.now() - providerStarted;
    await this.store.recordResult(claim, { outcome: 'success', reason: 'generated', payload: result, providerRequestId: result.providerRequestId,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, totalTokens: result.totalTokens } });
    reportLatency(this.latency, { stage: 'provider', taskId: claim.taskId, durationMs, outcome: 'success' });
    return true;
  }
}
