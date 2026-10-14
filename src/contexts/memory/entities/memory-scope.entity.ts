/**
 * Planned component: MemoryScope
 * Kind: Context-private entity
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Serialize purpose-specific consent and privacy revision for one guild/user.
 *
 * Scope:
 * Staged feature: activate only when personal memory ships.
 *
 * Planned fields:
 * id; guildId; userId; purposeSpecificConsent; allowedAudiences; privacyRevision;
 * retentionConfiguration; rowRevision; createdAt; updatedAt.
 *
 * Planned methods:
 * - grantConsent: Input: verified explicit purpose/audience/retention choice and expected
 *   revision. Output: revised consent binding for that scope.
 * - revokeConsent: Input: verified purpose/scope withdrawal and expected revision. Output:
 *   withdrawn consent with advanced privacy revision.
 * - advancePrivacyRevision: Input: deletion/expiry/change cause and expected revision. Output:
 *   next monotonic revision to fence derived work; services perform associated invalidation
 *   atomically.
 *
 * Collaborators/Boundaries:
 * Private context-owned MikroORM record. The owning service loads/persists it in the caller
 * transaction. Local methods use supplied values only; no ORM queries, external calls or queue
 * operations. Storage enforces same-guild references and unique keys. Internal IDs are UUIDs;
 * Discord IDs are strings. Mutable records use row revisions and conditional writes.
 *
 * Invariants:
 * Unique guild/user scope. Privacy revision never decreases. A later proposal/embedding commit
 * cannot reuse an old revision after withdrawal or deletion.
 */
