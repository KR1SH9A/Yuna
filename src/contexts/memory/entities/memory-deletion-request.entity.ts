/**
 * Planned component: MemoryDeletionRequest
 * Kind: Context-private entity
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Track retryable deletion progress when copies exist across prepared inputs, results, replies,
 * artifacts or caches.
 *
 * Scope:
 * Staged feature: activate only when personal memory ships.
 *
 * Planned fields:
 * id; guildId; scopeId; selectedFactReferences without retained content; deletionGeneration;
 * storageOwnerProgress; requestedAt; completedAt; revision.
 *
 * Planned methods:
 * - recordOwnerProgress: Input: owner acknowledgment, deletion generation and bounded
 *   progress/outstanding references. Output: updated retryable progress without reintroducing
 *   content.
 * - markCompleted: Input: required owner acknowledgments for the current generation. Output:
 *   completed deletion status once the specified managed copies are removed.
 *
 * Collaborators/Boundaries:
 * Private context-owned MikroORM record. The owning service loads/persists it in the caller
 * transaction. Local methods use supplied values only; no ORM queries, external calls or queue
 * operations. Storage enforces same-guild references and unique keys. Internal IDs are UUIDs;
 * Discord IDs are strings. Mutable records use row revisions and conditional writes.
 *
 * Invariants:
 * Eligibility is invalidated before asynchronous cleanup finishes. Completion describes managed
 * storage guarantees, not recall of provider inputs or already-delivered messages. Backup
 * retention/deletion has a separate declared lifecycle.
 */
