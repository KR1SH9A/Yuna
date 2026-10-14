/**
 * Planned component: AiTaskHandlers
 * Kind: Thin worker entry points
 * Owner: AI worker application
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Execute one prepared capability call and store its bound result. These named handlers may share
 * small technical helpers without a workflow engine.
 *
 * Planned methods:
 * - handleObservation: Receive a task ID; run LlmService.observeContent for its input.
 * - handleAssessment: Receive a task ID; run JevService.assessQuestions for its input.
 * - handleReplyGeneration: Receive a task ID; run LlmService.generateReply.
 * - handleExplanation: Receive a task ID; run LlmService.explainFindings when requested.
 * - handleEmbedding: Receive a task ID; run EmbeddingService.embedTexts when enabled.
 *
 * Shared execution steps:
 * Validate TaskSignalDto; read stored metadata through WorkerTaskStore.readTaskDescriptor, then
 * resolve the known handler through the static registry before creating a provider attempt.
 * Claim work, check deadline, pass the prepared-input release gate and validate the released
 * capability payload against its stored schema version. Use the task's
 * existing reservation for the first attempt, perform inference outside a transaction, and record
 * usage plus a schema-validated conditional result under the active attempt generation. Reserve
 * additional bounded retry allowance only when needed; restricted worker operations use stored policy/limits
 * rather than a worker-selected budget. Never reserve the first attempt twice.
 *
 * Boundaries:
 * Call one capability per task; never start the next moderation or conversation stage. Retries can
 * incur additional provider cost and cannot overwrite newer attempts.
 */
