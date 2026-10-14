/**
 * Planned component: ParticipantConsent
 * Kind: Context-private entity
 * Owner: Debates
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Record a participant decision for the exact debate processing and visibility scope.
 *
 * Scope:
 * Staged feature: activate only when debate mode ships.
 *
 * Planned fields:
 * id; guildId; sessionId; userId; acceptedScope; acceptedAt; withdrawalState; withdrawnAt;
 * revision.
 *
 * Planned methods:
 * - withdraw: Input: verified participant withdrawal and expected revision. Output: withdrawn
 *   consent for the recorded scope; DebateService coordinates session/task/publication
 *   consequences.
 *
 * Collaborators/Boundaries:
 * Private context-owned MikroORM record. The owning service loads/persists it in the caller
 * transaction. Local methods use supplied values only; no ORM queries, external calls or queue
 * operations. Storage enforces same-guild references and unique keys. Internal IDs are UUIDs;
 * Discord IDs are strings. Mutable records use row revisions and conditional writes.
 *
 * Invariants:
 * Debate consent does not authorize personal-memory retention. A changed scope
 * requires a fresh explicit consent record rather than silently widening this one.
 */
