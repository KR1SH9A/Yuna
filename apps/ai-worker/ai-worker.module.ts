/**
 * Planned component: AiWorkerModule
 * Kind: Composition root
 * Owner: AI worker application
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Wire individual provider capabilities to explicit task handlers.
 *
 * Planned methods:
 * - None. Dependency registration only when implemented.
 *
 * Planned wiring:
 * TaskRegistry, AiTaskHandlers, restricted WorkerTaskStore, Usage and Artifacts APIs. LlmModule
 * and JevModule; EmbeddingsModule only when needed. A fresh ORM context for each job or recovery
 * entry point.
 *
 * Boundaries:
 * Do not import business contexts, their entities, or Discord adapters. Provider capabilities do
 * not know the job queue; handlers make the connection.
 */
