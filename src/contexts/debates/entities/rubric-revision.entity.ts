/**
 * Planned component: RubricRevision
 * Kind: Immutable retained record
 * Owner: Debates
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Freeze criteria, weights and acceptance/outcome rules agreed for evaluation.
 *
 * Scope:
 * Staged feature: activate only when debate mode ships.
 *
 * Planned fields:
 * id; guildId; rubricId; revision; criteria; weights; evaluationConfigurationVersions;
 * winningMargin/tie rules; createdAt; activationTime.
 *
 * Planned methods:
 * No mutation methods planned. Criteria or weight changes require a new revision and any necessary
 * renewed session consent.
 *
 * Collaborators/Boundaries:
 * Private context-owned MikroORM record. The owning service loads/persists it in the caller
 * transaction. Local methods use supplied values only; no ORM queries, external calls or queue
 * operations. Storage enforces same-guild references and unique keys. Internal IDs are UUIDs;
 * Discord IDs are strings. Mutable records use row revisions and conditional writes.
 *
 * Invariants:
 * Scores use the agreed frozen rubric, not a model-generated replacement. Weight coherence is
 * validated before use; deterministic code computes totals.
 */
