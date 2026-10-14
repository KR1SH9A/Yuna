/**
 * Planned component: LlmModule
 * Kind: Provider capability module
 * Owner: AI worker / LLM
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Register LlmService, selected provider SDK configuration and versioned templates.
 *
 * Planned methods:
 * - None. Dependency registration only when implemented.
 *
 * Boundaries:
 * Capability operations remain distinct even if they share a provider client. No imports of Jev,
 * business contexts, Jobs or Discord. Add a separate LlmClient only when it adds useful protocol
 * isolation beyond the SDK.
 */
