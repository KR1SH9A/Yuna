/**
 * Planned component: AiWorkerBootstrap
 * Kind: Runtime entry point
 * Owner: AI worker application
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Start restricted task consumers and provider capabilities.
 *
 * Planned methods:
 * - bootstrap: Read worker-scoped configuration, compose AiWorkerModule, and start enabled task
 *   consumers with bounded concurrency.
 * - shutdown: Stop new claims, drain or cancel bounded provider work, record outstanding outcomes
 *   where possible, and close worker resources.
 *
 * Boundaries:
 * Provider credentials and restricted work access only; no Discord bot token. A crash cannot be
 * repaired by pretending a potentially billed call never ran.
 */
