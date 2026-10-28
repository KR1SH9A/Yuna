/**
 * Planned component: JevModule
 * Kind: Provider capability module
 * Owner: AI worker / Jev
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: JevService is implemented. apps/ai-worker/ai-worker.module.ts constructs it directly; no framework module is required.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility:
 * Register JevService and its selected SDK/HTTP configuration.
 *
 * Planned methods:
 * - None. Dependency registration only when implemented.
 *
 * Boundaries:
 * Expose the bounded assessment capability to worker handlers. May depend on plain AI contracts
 * and technical libraries. No imports of LLM, business contexts, queue services, Discord or
 * business entities. Add a separate JevClient only if SDK/protocol complexity warrants it.
 */
