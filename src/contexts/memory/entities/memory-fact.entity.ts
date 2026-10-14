/**
 * Planned component: MemoryFact
 * Kind: Immutable retained record
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Store one accepted personal fact with exact consent, provenance, audience and retention binding.
 *
 * Scope:
 * Staged feature: activate only when personal memory ships.
 *
 * Planned fields:
 * id; guildId; subjectUserId; consentScopeId; consentRevision; factText; sourceProvenance;
 * audience; contentHash; createdAt; expiresAt.
 *
 * Planned methods:
 * No mutation methods planned. Corrections create an explicitly authorized replacement under
 * current consent. Owner-controlled deletion physically removes fact content; a separate
 * non-content invalidation record may remain.
 *
 * Collaborators/Boundaries:
 * Private context-owned MikroORM record. The owning service loads/persists it in the caller
 * transaction. Local methods use supplied values only; no ORM queries, external calls or queue
 * operations. Storage enforces same-guild references and unique keys. Internal IDs are UUIDs;
 * Discord IDs are strings. Mutable records use row revisions and conditional writes.
 *
 * Invariants:
 * Fact text is untrusted context, never authority. Exact subject/guild and destination constraints
 * apply to retrieval and publication. Soft deletion alone must not leave content/vectors eligible
 * or allow late jobs to recreate them.
 */
