/**
 * Planned component: EmbeddingService
 * Kind: Provider adapter
 * Owner: AI worker / embeddings
 * Status: Design scaffold only; not implemented. Used when Memory ships.
 *
 * Responsibility:
 * Produce bounded vectors for authorized text without owning retrieval policy.
 *
 * Planned methods:
 * - embedTexts: Receive EmbeddingInput; call the configured provider, validate vector
 *   count/dimensions and input correspondence, then return EmbeddingResult and usage.
 *
 * Boundaries:
 * No consent decisions, similarity queries, Memory writes or other provider orchestration. The
 * Memory owner rechecks content and privacy revisions when accepting the result.
 */
