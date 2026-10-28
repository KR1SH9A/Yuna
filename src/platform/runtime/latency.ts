/** Bounded timing telemetry for the conversation pipeline; never log message or account data. */
export type LatencyStage = 'admission_commit' | 'queue_wait' | 'provider' | 'completion_wait'
  | 'acceptance_commit' | 'discord_delivery' | 'end_to_end';
export type LatencyOutcome = 'admitted' | 'accepted' | 'discarded' | 'success' | 'failure'
  | 'uncertain' | 'delivered' | 'definitive_failure' | 'unknown';
export interface LatencySample {
  stage: LatencyStage;
  durationMs: number;
  requestId?: string;
  taskId?: string;
  outcome: LatencyOutcome;
}
export type LatencyReporter = (sample: Readonly<LatencySample>) => void;

const stages = new Set<LatencyStage>(['admission_commit', 'queue_wait', 'provider', 'completion_wait',
  'acceptance_commit', 'discord_delivery', 'end_to_end']);
const outcomes = new Set<LatencyOutcome>(['admitted', 'accepted', 'discarded', 'success', 'failure',
  'uncertain', 'delivered', 'definitive_failure', 'unknown']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Services remain silent unless the application supplies a reporter. */
export const noLatencyReporter: LatencyReporter = () => {};

/** Rebuild an allow-listed sample and isolate logger failures from committed business work. */
export function reportLatency(reporter: LatencyReporter, sample: LatencySample): void {
  if (!stages.has(sample.stage) || !outcomes.has(sample.outcome)
    || !Number.isFinite(sample.durationMs) || sample.durationMs < 0 || sample.durationMs > Number.MAX_SAFE_INTEGER) return;
  const requestId = typeof sample.requestId === 'string' && uuid.test(sample.requestId) ? sample.requestId : undefined;
  const taskId = typeof sample.taskId === 'string' && uuid.test(sample.taskId) ? sample.taskId : undefined;
  if (!requestId && !taskId) return;
  try {
    reporter(Object.freeze({ stage: sample.stage, durationMs: Math.round(sample.durationMs * 100) / 100,
      ...(requestId ? { requestId } : {}), ...(taskId ? { taskId } : {}), outcome: sample.outcome }));
  } catch { /* Telemetry must never retry a provider call or undo a successful delivery. */ }
}

/** Emit one JSON line per sample; the injected writer also makes privacy behavior testable. */
export function createLatencyLogger(
  role: 'bot' | 'ai-worker', write: (line: string) => void = line => console.info(line),
): LatencyReporter {
  return sample => reportLatency(safe => write(JSON.stringify({ event: 'conversation_latency', role, ...safe })), sample);
}
