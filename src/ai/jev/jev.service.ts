/** Execute one bounded OpenRouter Decisions request and preserve typed Jev answers without granting authority. */
import type { ProviderConfig } from '../../platform/config/runtime-config.js';
import { assertNonNegativeInteger, copyJson, invariant } from '../../platform/db/entity-values.js';
import type { AssessmentAnswer, AssessmentInput, AssessmentQuestion, AssessmentResult } from '../contracts/assessment.contracts.js';

export type JevErrorCode = 'invalid_configuration' | 'invalid_input' | 'cancelled' | 'timeout'
  | 'authentication' | 'insufficient_balance' | 'invalid_request' | 'rate_limited'
  | 'provider_unavailable' | 'invalid_response' | 'network';

/** Public errors contain fixed classifications only; any dispatched failure may still have incurred cost. */
export class JevError extends Error {
  /** Retain safe operational facts without attaching credential-bearing transport errors or provider bodies. */
  constructor(readonly code: JevErrorCode, readonly costMayHaveBeenIncurred: boolean) {
    super(`Assessment failed (${code})`);
    this.name = 'JevError';
  }
}

const endpoint = 'https://openrouter.ai/api/alpha/decisions';
const maxRequestBytes = 32 * 1024;
const maxResponseBytes = 64 * 1024;
const keyPattern = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

/** Accept records only; arrays and null cannot satisfy a provider envelope or question map. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Provider/model identifiers remain bounded tokens; caller data never selects an endpoint. */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\p{Cc}]/u.test(value);
}

/** Require a nonempty bounded human description without changing the owner's criteria. */
function assertDescription(value: unknown): asserts value is string {
  invariant(typeof value === 'string' && value.trim().length > 0 && value.length <= 2000, 'Invalid assessment description');
}

/** Reject missing/extra keys so answers cannot silently bind to another question or option. */
function assertKeys(value: unknown, expected: readonly string[]): asserts value is Record<string, unknown> {
  invariant(isRecord(value) && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key)), 'Mismatched assessment keys');
}

/** Snapshot and validate owner input before disclosure, retaining only the capability's named fields. */
function prepareInput(input: AssessmentInput): AssessmentInput {
  invariant(isRecord(input), 'Invalid assessment input');
  const prepared = copyJson({ schemaVersion: input.schemaVersion, configurationVersion: input.configurationVersion,
    state: input.state, questions: input.questions, sourceReferences: input.sourceReferences });
  invariant(prepared.schemaVersion === 1 && typeof prepared.configurationVersion === 'string'
    && /^[a-zA-Z0-9_.:-]{1,120}$/.test(prepared.configurationVersion), 'Invalid assessment version');
  invariant(isRecord(prepared.state) && Object.keys(prepared.state).length > 0, 'Missing prepared state');
  invariant(Array.isArray(prepared.sourceReferences) && prepared.sourceReferences.length > 0 && prepared.sourceReferences.length <= 50
    && prepared.sourceReferences.every(value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\p{Cc}]/u.test(value))
    && new Set(prepared.sourceReferences).size === prepared.sourceReferences.length, 'Invalid source references');
  invariant(isRecord(prepared.questions), 'Missing assessment questions');
  const entries = Object.entries(prepared.questions);
  invariant(entries.length > 0 && entries.length <= 20, 'Invalid question count');
  for (const [id, question] of entries) {
    invariant(keyPattern.test(id) && isRecord(question), 'Invalid question identity');
    assertDescription(question.instructions);
    if (question.type === 'choice') {
      invariant(isRecord(question.criteria), 'Missing choice criteria');
      const options = Object.entries(question.criteria);
      invariant(options.length >= 2 && options.length <= 20, 'Invalid option count');
      for (const [label, description] of options) { invariant(keyPattern.test(label), 'Invalid choice label'); assertDescription(description); }
    } else if (question.type === 'score') {
      invariant(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10, 'Invalid score levels');
      for (const level of question.criteria) assertDescription(level);
    } else {
      invariant(question.type === 'noul', 'Unsupported assessment type');
      if (question.criteria !== undefined) {
        assertKeys(question.criteria, ['true', 'false']);
        assertDescription(question.criteria.true); assertDescription(question.criteria.false);
      }
    }
    invariant(Object.keys(question).every(key => ['type', 'instructions', 'criteria'].includes(key)), 'Unsupported question field');
  }
  invariant(new TextEncoder().encode(JSON.stringify(prepared)).byteLength <= maxRequestBytes, 'Prepared input exceeds byte limit');
  return prepared;
}

/** Preserve probabilities as probabilities; nonfinite or out-of-range numbers cannot become findings. */
function probability(value: unknown): number {
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, 'Invalid assessment probability');
  return value;
}

/** Validate the complete distribution without normalizing malformed measurements into apparently valid data. */
function distribution(value: unknown, keys: readonly string[]): Readonly<Record<string, number>> {
  assertKeys(value, keys);
  const entries = keys.map(key => [key, probability(value[key])] as const);
  invariant(Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) <= 0.000001, 'Invalid probability sum');
  return Object.freeze(Object.fromEntries(entries));
}

/** Validate type-specific semantics and discard every provider field outside the supported answer contract. */
function parseAnswer(value: unknown, question: AssessmentQuestion): AssessmentAnswer {
  invariant(isRecord(value) && value.type === question.type, 'Mismatched answer type');
  if (question.type === 'noul') return Object.freeze({ type: 'noul', noul: probability(value.noul) });
  const confidence = probability(value.confidence);
  if (question.type === 'choice') {
    const probabilities = distribution(value.probabilities, Object.keys(question.criteria));
    invariant(typeof value.choice === 'string' && Object.hasOwn(probabilities, value.choice), 'Unknown choice');
    invariant(probabilities[value.choice]! >= Math.max(...Object.values(probabilities)) - 0.000001, 'Choice is not the most likely option');
    return Object.freeze({ type: 'choice', choice: value.choice, confidence, probabilities });
  }
  const levels = question.criteria.map((_level, index) => String(index));
  const probabilities = distribution(value.probabilities, levels);
  assertKeys(value.legend, levels);
  invariant(levels.every((key, index) => (value.legend as Record<string, unknown>)[key] === question.criteria[index]), 'Mismatched score legend');
  invariant(typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= 0 && value.score <= levels.length - 1, 'Invalid score');
  const weighted = levels.reduce((sum, key) => sum + Number(key) * probabilities[key]!, 0);
  // The documented API examples round scores to two decimal places; retain the supplied value.
  invariant(Math.abs(value.score - weighted) <= 0.010001, 'Score does not match its distribution');
  return Object.freeze({ type: 'score', score: value.score, confidence, probabilities,
    legend: Object.freeze(Object.fromEntries(levels.map((key, index) => [key, question.criteria[index]!]))), });
}

/** Expand a JSON decimal spelling without converting money through a binary floating-point calculation. */
function decimalCost(value: unknown): string {
  invariant(isRecord(value) && typeof value.source === 'string' && typeof value.value === 'number'
    && Number.isFinite(value.value) && value.value >= 0, 'Missing reported USD cost');
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(value.source);
  invariant(match, 'Invalid reported USD decimal');
  const exponent = Number(match[3] ?? 0);
  invariant(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 100, 'Unsupported cost exponent');
  const digits = match[1]! + (match[2] ?? '');
  const point = match[1]!.length + exponent;
  const whole = (point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0')).replace(/^0+(?=\d)/, '');
  const fraction = (point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point)).replace(/0+$/, '');
  invariant(whole.length <= 20 && fraction.length <= 18, 'Reported cost exceeds supported decimal precision');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Parse a response with Node 24's JSON source context so usage.cost keeps the precision the provider actually sent. */
function parseResult(text: string, input: AssessmentInput, requestedModel: string): AssessmentResult {
  try {
    const costSources = new WeakMap<object, string>();
    const value: unknown = JSON.parse(text, function (this: object, key: string, item: unknown, context?: { source?: string }) {
      if (key === 'cost' && context?.source) costSources.set(this, context.source);
      return item;
    });
    invariant(isRecord(value) && isIdentifier(value.model), 'Invalid assessment model');
    assertKeys(value.answers, Object.keys(input.questions));
    const answers = Object.freeze(Object.fromEntries(Object.entries(input.questions)
      .map(([id, question]) => [id, parseAnswer((value.answers as Record<string, unknown>)[id], question)])));
    invariant(value.id === undefined || isIdentifier(value.id), 'Invalid provider request ID');
    invariant(value.provider === undefined || (typeof value.provider === 'string' && value.provider.trim().length > 0
      && value.provider.length <= 200 && !/[\p{Cc}]/u.test(value.provider)), 'Invalid provider name');
    invariant(isRecord(value.usage), 'Missing assessment usage');
    assertNonNegativeInteger(value.usage.input_tokens as number, 'Measured input tokens');
    assertNonNegativeInteger(value.usage.output_tokens as number, 'Measured output tokens');
    const inputTokens = value.usage.input_tokens as number;
    const outputTokens = value.usage.output_tokens as number;
    assertNonNegativeInteger(inputTokens + outputTokens, 'Measured total tokens');
    return Object.freeze({ schemaVersion: 1, configurationVersion: input.configurationVersion,
      sourceReferences: Object.freeze([...input.sourceReferences]), outcome: 'assessed', uncertaintyReason: null,
      answers, requestedModel, model: value.model, providerRequestId: value.id as string | undefined ?? null,
      provider: value.provider as string | undefined ?? null, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      costUsd: decimalCost({ value: value.usage.cost, source: costSources.get(value.usage) }) });
  } catch { throw new JevError('invalid_response', true); }
}

/** Explicit fake answers are deliberately inconclusive and must never be accepted as a live rule finding. */
function fakeResult(input: AssessmentInput): AssessmentResult {
  const answers = Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, Object.freeze({ type: 'noul' as const, noul: 0.5 })];
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_level, index) => String(index));
    const probabilities = Object.freeze(Object.fromEntries(keys.map(key => [key, 1 / keys.length])));
    const answer: AssessmentAnswer = question.type === 'choice'
      ? Object.freeze({ type: 'choice', choice: keys[0]!, confidence: 0, probabilities })
      : Object.freeze({ type: 'score', score: (keys.length - 1) / 2, confidence: 0, probabilities,
        legend: Object.freeze(Object.fromEntries(keys.map((key, index) => [key, question.criteria[index]!]))), });
    return [id, answer];
  }));
  return Object.freeze({ schemaVersion: 1, configurationVersion: input.configurationVersion,
    sourceReferences: Object.freeze([...input.sourceReferences]), outcome: 'uncertain', uncertaintyReason: 'fake_provider',
    answers: Object.freeze(answers), requestedModel: 'fake', model: 'fake', providerRequestId: null, provider: null,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: '0' });
}

/** Provider-only capability: no retrieval, LLM calls, task acceptance, policy threshold or Discord action. */
export class JevService {
  private readonly config: ProviderConfig;

  /** Snapshot validated role configuration; fake mode never reads live credentials or model settings. */
  constructor(config: ProviderConfig, private readonly requestTimeoutMs: number, private readonly fetchImpl: typeof fetch = fetch) {
    try {
      invariant(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1 && requestTimeoutMs <= 120_000
        && typeof fetchImpl === 'function' && (config?.mode === 'fake' || config?.mode === 'live'), 'Invalid assessment configuration');
      if (config.mode === 'fake') this.config = Object.freeze({ mode: 'fake' });
      else {
        invariant(config.endpoint === endpoint && isIdentifier(config.model) && isIdentifier(config.apiKey), 'Invalid assessment provider');
        this.config = Object.freeze({ mode: 'live', endpoint, model: config.model, apiKey: config.apiKey });
      }
    } catch { throw new JevError('invalid_configuration', false); }
  }

  /** Execute at most one provider request, with a whole-response deadline and explicit uncertain-cost failures. */
  async assessQuestions(input: AssessmentInput, signal?: AbortSignal): Promise<AssessmentResult> {
    let prepared: AssessmentInput;
    let body: string;
    try {
      prepared = prepareInput(input);
      body = JSON.stringify({ model: this.config.mode === 'live' ? this.config.model : 'fake', state: prepared.state, questions: prepared.questions });
      invariant(new TextEncoder().encode(body).byteLength <= maxRequestBytes, 'Assessment request exceeds byte limit');
    } catch { throw new JevError('invalid_input', false); }
    if (signal?.aborted) throw new JevError('cancelled', false);
    if (this.config.mode === 'fake') return fakeResult(prepared);
    const config = this.config;
    const deadline = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let dispatched = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    /** Report cancellation without preserving transport details, including whether dispatch may have incurred cost. */
    const cancellationError = () => new JevError(signal?.aborted ? 'cancelled' : 'timeout', dispatched);
    /** Keep a removable listener reference while the bounded body reader is active. */
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      /** Abort both the awaited operation and any active stream reader immediately. */
      onAbort = () => { reject(cancellationError()); if (reader) void reader.cancel().catch(() => {}); };
      requestSignal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => deadline.abort(), this.requestTimeoutMs);
    /** Read bounded bytes before parsing; even a transport ignoring abort cannot hold the caller open. */
    const execute = async (): Promise<AssessmentResult> => {
      if (requestSignal.aborted) throw cancellationError();
      dispatched = true;
      const response = await this.fetchImpl(config.endpoint, { method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body });
      if (requestSignal.aborted) { void response.body?.cancel().catch(() => {}); throw cancellationError(); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const code: JevErrorCode = response.status === 401 ? 'authentication' : response.status === 402 ? 'insufficient_balance'
          : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'provider_unavailable' : 'invalid_request';
        throw new JevError(code, true);
      }
      if (!response.body) throw new JevError('invalid_response', true);
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (requestSignal.aborted) throw cancellationError();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxResponseBytes) throw new JevError('invalid_response', true);
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new JevError('invalid_response', true); }
      return parseResult(text, prepared, config.model);
    };
    try { return await Promise.race([execute(), aborted]); }
    catch (error) {
      if (error instanceof JevError) throw error;
      if (requestSignal.aborted) throw cancellationError();
      throw new JevError('network', dispatched);
    } finally {
      clearTimeout(timer);
      requestSignal.removeEventListener('abort', onAbort);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
}
