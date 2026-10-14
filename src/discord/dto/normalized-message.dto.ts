/**
 * Planned component: NormalizedDiscordMessageDto
 * Kind: Normalized event DTO
 * Owner: Discord boundary
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Carry a bounded message snapshot from DiscordInputNormalizer to bot intake without SDK objects.
 *
 * Planned fields:
 * Trusted source metadata: SourceProvenance from ../contracts.ts; known eventKind.
 * Untrusted content: bounded message text and attachment metadata/references.
 * Coverage: explicitly missing fields, partial-message state and unavailable attachment markers.
 *
 * Producer and consumers:
 * normalizeMessage / normalizeMessageRevision -> DiscordHandlers -> durable intake. Bot routing
 * maps the retained snapshot into the owning feature's DTO and separately supplies trusted source
 * values. This transport shape is not a shared business entity or a context-owned request schema.
 *
 * Validation:
 * Check external IDs as strings, known event kinds, timestamp/revision shape and content/attachment
 * limits. Never infer an author or original content for a partial event. Validate on receipt and
 * when reading a retained serialized snapshot under its schema version.
 *
 * Planned methods:
 * None. Fields and boundary validation only; no business decisions, queries or networking.
 *
 * Invariants:
 * Source identity comes from verified transport metadata, never message text. Raw attachment URLs
 * do not prove durable capture. Installation state and permission checks remain with their owners.
 */
