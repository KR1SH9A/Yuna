/**
 * Planned component: JevService
 * Kind: Provider adapter
 * Owner: AI worker / Jev
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Execute a prepared structured assessment and normalize the provider result.
 *
 * Planned methods:
 * - assessQuestions: Receive AssessmentInput; encode the configured question types, call the
 *   provider within time/size limits, validate the response schema and ranges, and return
 *   AssessmentResult or explicit uncertainty/failure with usage.
 *
 * Boundaries:
 * No LLM calls, source retrieval, case progression, permission checks or Discord effects. Do not
 * compute database task staleness here; the worker and feature owner check binding. Contexts
 * supply criteria. Provider parsing must preserve each answer type's semantics.
 */
