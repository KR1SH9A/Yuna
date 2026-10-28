/** Text observation copies attributable spans only; policy conclusions and effects belong to the feature owner. */
export interface ObservationInput {
  readonly schemaVersion: 1;
  readonly evidenceRevisionId: string;
  readonly content: string;
  readonly sourceReferences: readonly string[];
  readonly maxOutputTokens: number;
}
export interface ObservationFact {
  readonly statement: string;
  readonly quote: string;
  /** Half-open JavaScript UTF-16 offsets into the exact supplied content. */
  readonly start: number;
  readonly end: number;
}
export interface ObservationResult {
  readonly schemaVersion: 1;
  readonly evidenceRevisionId: string;
  readonly sourceReferences: readonly string[];
  readonly outcome: 'observed' | 'uncertain';
  readonly uncertaintyReason: 'fake_provider' | null;
  readonly inspectedBody: boolean;
  readonly facts: readonly ObservationFact[];
  readonly limitations: readonly string[];
  readonly providerRequestId: string | null;
  readonly requestedModel: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}
