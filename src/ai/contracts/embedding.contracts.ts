/**
 * Planned component: EmbeddingContracts
 * Kind: Versioned capability schemas
 * Owner: AI contracts
 * Status: Design scaffold only; not implemented. Used when Memory ships.
 *
 * Responsibility:
 * Describe bounded embedding generation independent of fact storage.
 *
 * Planned methods:
 * - None. Plain values and validation schemas only.
 *
 * Planned values:
 * EmbeddingInput: authorized texts and content hashes, provider/model configuration, expected
 * output shape and size bounds.
 * EmbeddingResult: ordered vectors, corresponding content references, model/version, dimensions
 * and usage metadata.
 *
 * Invariants:
 * Do not assume a vector dimension before selecting a model. Memory owns consent and acceptance;
 * the capability cannot recreate deleted facts.
 */
