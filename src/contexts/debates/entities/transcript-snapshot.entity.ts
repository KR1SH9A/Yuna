/**
 * Planned component: TranscriptSnapshot
 * Kind: Immutable retained record
 * Owner: Debates
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Freeze the exact ordered declared transcript and coverage used for an evaluation.
 *
 * Scope:
 * Staged feature: activate only when debate mode ships.
 *
 * Planned fields:
 * id; guildId; sessionId; revision; orderedEntryReferences; contentHash; declaredCoverage; gaps;
 * frozenAt; retention/expiry metadata.
 *
 * Planned methods:
 * No mutation methods planned. A changed evaluation scope creates a new explicitly authorized
 * snapshot and task binding.
 *
 * Collaborators/Boundaries:
 * Private context-owned MikroORM record. The owning service loads/persists it in the caller
 * transaction. Local methods use supplied values only; no ORM queries, external calls or queue
 * operations. Storage enforces same-guild references and unique keys. Internal IDs are UUIDs;
 * Discord IDs are strings. Mutable records use row revisions and conditional writes.
 *
 * Invariants:
 * Frozen identity binds scoring and citations. Missing coverage remains explicit; selected
 * fragments cannot silently be represented as the entire debate.
 */
