/**
 * Planned component: Task registration lookup
 * Kind: Static composition data and lookup function
 * Owner: AI worker application
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Map supported stored task kinds and schema versions to known handlers.
 *
 * Planned functions:
 * - resolveHandler: Receive trusted task kind/version metadata and return the registered handler
 *   or an explicit unsupported-version outcome.
 *
 * Planned entries:
 * Observation, structured assessment, reply generation, explanation and enabled embedding work.
 * Capability schemas remain separate; no universal payload with optional fields.
 *
 * Boundaries:
 * Static application composition, not runtime plugin discovery or arbitrary dispatch. Unknown
 * versions must never be guessed, interpreted as source code, or silently upgraded.
 * This file does not require an injectable service class. The worker composition root constructs
 * the known handler mapping; the lookup is not a DI provider or a new workflow layer.
 */
