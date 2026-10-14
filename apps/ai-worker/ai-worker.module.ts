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
 * AiTaskHandlers, restricted WorkerTaskStore, Usage and Artifacts APIs. Construct the static
 * task.registry.ts lookup from known handlers; do not register a TaskRegistry service. LlmModule
 * and JevModule; EmbeddingsModule only when needed. A fresh ORM context for each job or recovery
 * entry point.
 *
 * Boundaries:
 * Do not import business contexts, their entities, or Discord adapters. Provider capabilities do
 * not know the job queue; handlers make the connection.
 * TaskSignalDto and AI schemas are data/validation imports, not DI providers. Validate on the
 * queue path and after provider output; an input DTO does not replace the Jobs disclosure gate.
 */
