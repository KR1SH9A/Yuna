/**
 * Planned component: TranscriptEntry
 * Kind: Immutable retained record
 * Owner: Debates
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Preserve an ordered attributable transcript item or source-change marker.
 *
 * Scope:
 * Staged feature: activate only when debate mode ships.
 *
 * Planned fields:
 * id; guildId; sessionId; sequence; sourceReference; authorId; sourceRevision; retained content or
 * controlled snapshot reference; edit/deletion/gap markers; sourceTime; capturedAt; contentHash.
 *
 * Planned methods:
 * No mutation methods planned. Append a new explicit source-change marker/revision instead of
 * overwriting retained history; owner-controlled retention governs eventual removal.
 *
 * Collaborators/Boundaries:
 * Private context-owned MikroORM record. The owning service loads/persists it in the caller
 * transaction. Local methods use supplied values only; no ORM queries, external calls or queue
 * operations. Storage enforces same-guild references and unique keys. Internal IDs are UUIDs;
 * Discord IDs are strings. Mutable records use row revisions and conditional writes.
 *
 * Invariants:
 * Author comes from trusted source provenance. Keep declared opposing arguments and chronology. A
 * sliding/pruned conversation buffer cannot serve as the debate transcript.
 */
