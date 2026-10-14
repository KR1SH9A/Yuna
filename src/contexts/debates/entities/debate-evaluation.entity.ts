/**
 * Planned component: DebateEvaluation
 * Kind: Context-private entity
 * Owner: Debates
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Retain accepted criterion evidence, deterministic totals and separate publication status.
 *
 * Scope:
 * Staged feature: activate only when debate mode ships.
 *
 * Planned fields:
 * id; guildId; sessionId; transcriptRevision/hash; rubricRevision; acceptedTaskResultReferences;
 * criterionScores; evidenceReferences; codeComputedTotals; uncertainty/tie outcome; limitations;
 * publicationStatus; publicationMessageReference; acceptedAt; publishedAt; revision.
 *
 * Planned methods:
 * - recordPublication: Input: confirmed matching destination/message evidence. Output: published
 *   status without changing accepted scores or frozen bindings.
 * - recordPublicationUncertainty: Input: bound delivery attempt and unresolved outcome. Output:
 *   pending/unresolved publication status, avoiding an unsupported success claim.
 *
 * Collaborators/Boundaries:
 * Private context-owned MikroORM record. The owning service loads/persists it in the caller
 * transaction. Local methods use supplied values only; no ORM queries, external calls or queue
 * operations. Storage enforces same-guild references and unique keys. Internal IDs are UUIDs;
 * Discord IDs are strings. Mutable records use row revisions and conditional writes.
 *
 * Invariants:
 * Accepted evaluation data is immutable; only publication lifecycle changes locally. New
 * evidence/rubric requires a new evaluation. No score can authorize an access change or sanction.
 */
