/**
 * Planned component: FactEmbedding
 * Kind: Immutable retained record
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Keep a model-specific vector tied to an exact permitted fact content and privacy revision.
 *
 * Scope:
 * Staged feature: activate only when personal memory ships.
 *
 * Planned fields:
 * id; guildId; factId; embeddingModel; modelVersion; dimensions; contentHash; privacyRevision;
 * vector; createdAt.
 *
 * Planned methods:
 * No mutation methods planned. Re-embedding creates a new model/content-bound record through
 * validated owner acceptance. Deleting a fact physically removes its associated vectors.
 *
 * Collaborators/Boundaries:
 * Private context-owned MikroORM record. The owning service loads/persists it in the caller
 * transaction. Local methods use supplied values only; no ORM queries, external calls or queue
 * operations. Storage enforces same-guild references and unique keys. Internal IDs are UUIDs;
 * Discord IDs are strings. Mutable records use row revisions and conditional writes.
 *
 * Invariants:
 * Dimensions follow the selected model contract; never hard-code them before selection. Mismatched
 * content hash, model identity or privacy revision makes a result ineligible. Embedding workers
 * cannot write this record directly.
 */
