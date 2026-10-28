/** Execute one explicitly routed moderation capability after committed claim/disclosure/dispatch gates. */
import { LlmError, type LlmService } from '../../src/ai/llm/llm.service.js';
import { JevError, type JevService } from '../../src/ai/jev/jev.service.js';
import type { ModerationWorkerStore } from '../../src/platform/jobs/moderation-worker.store.js';
import type { ModerationTaskKind, ModerationTaskOutcome } from '../../src/platform/jobs/moderation-task.contracts.js';
import { noLatencyReporter, reportLatency, type LatencyReporter } from '../../src/platform/runtime/latency.js';

export class ModerationTaskHandlers {
  /** Fixed capability routes/model configuration prevent stored text from choosing a provider or next stage. */
  constructor(private readonly store: Pick<ModerationWorkerStore, 'claimNext' | 'releasePreparedInput' | 'recordProviderStart' | 'recordResult'>,
    private readonly llm: Pick<LlmService, 'observeContent'>, private readonly jev: Pick<JevService, 'assessQuestions'>,
    private readonly executorId: string, private readonly observationModel: string, private readonly assessmentModel: string,
    private readonly timeoutMs: number, private readonly latency: LatencyReporter = noLatencyReporter) {}

  /** One claimed task means one provider invocation at most; a failed durable write is never retried as provider I/O. */
  async runOne(signal: AbortSignal, kind: ModerationTaskKind): Promise<boolean> {
    if (signal.aborted) return false;
    const claim = await this.store.claimNext(this.executorId, kind, kind === 'moderation.observe' ? this.observationModel : this.assessmentModel);
    if (!claim) return false;
    /** Leave a small interval to persist the response before the task or claim expires. */
    const remaining = () => Math.min(new Date(claim.deadline).getTime(), new Date(claim.leaseUntil).getTime()) - Date.now() - 500;
    if (remaining() <= 0 || signal.aborted) {
      await this.store.recordResult(claim, { outcome: 'failure', reason: 'cancelled_before_release' }); return true;
    }
    const prepared = await this.store.releasePreparedInput(claim);
    if (!prepared || prepared.kind !== claim.kind || claim.kind !== kind || signal.aborted || !await this.store.recordProviderStart(claim)) {
      await this.store.recordResult(claim, { outcome: 'failure', reason: 'disclosure_denied' }); return true;
    }
    const budget = remaining();
    if (budget <= 0 || signal.aborted) {
      await this.store.recordResult(claim, { outcome: 'failure', reason: 'cancelled_before_provider' }); return true;
    }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(budget, this.timeoutMs)))]);
    const start = performance.now(); let outcome: ModerationTaskOutcome;
    try {
      if (prepared.kind === 'moderation.observe') {
        const result = await this.llm.observeContent(prepared.input, requestSignal);
        outcome = { outcome: 'success', reason: 'observation_completed', payload: result, providerRequestId: result.providerRequestId,
          usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, totalTokens: result.totalTokens } };
      } else {
        const result = await this.jev.assessQuestions(prepared.input, requestSignal);
        outcome = { outcome: 'success', reason: 'assessment_completed', payload: result, providerRequestId: result.providerRequestId,
          usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, totalTokens: result.totalTokens, costUsd: result.costUsd } };
      }
    } catch (error) {
      const known = error instanceof LlmError || error instanceof JevError;
      outcome = { outcome: known && !error.costMayHaveBeenIncurred ? 'failure' : 'uncertain', reason: known ? error.code : 'provider_failure' };
    }
    await this.store.recordResult(claim, outcome);
    reportLatency(this.latency, { stage: 'provider', taskId: claim.taskId, durationMs: performance.now() - start, outcome: outcome.outcome });
    return true;
  }
}
