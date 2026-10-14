/**
 * Planned component: TargetExecutionState
 * Kind: Context-private entity
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Serialize conflicting ban and unban work for the same guild/account across cases, retries and
 * staff actions.
 *
 * Planned fields:
 * guildId; targetUserId as composite key; generation; unresolvedActionId; revision; updatedAt.
 *
 * Planned methods:
 * - claim: Input: action reference and expected generation after the shared safety gate. Output:
 *   next target generation/reservation when no conflicting unresolved action exists.
 * - retainUnresolved: Input: matching action/generation and uncertainty cause. Output: continued
 *   exclusive unresolved reference; another case cannot overtake it.
 * - releaseResolved: Input: matching action/generation and established resolution. Output: cleared
 *   reservation with advanced generation, allowing newly authorized work.
 *
 * Collaborators/Boundaries:
 * Private context-owned persistence record. The owning service loads and persists it through
 * MikroORM in the caller's transaction. Transition methods operate on supplied values only; they
 * do not query, enqueue, or call external systems.
 *
 * Invariants:
 * Lease expiry never proves the old executor stopped. Only established resolution permits safe
 * release; serializing a database row cannot make Discord calls exactly once. Tenant references
 * must remain in one guild through database-enforced constraints. Internal IDs are UUIDs; Discord
 * IDs are strings. Row revision and conditional writes protect mutable transitions; entity checks
 * alone do not replace concurrency constraints.
 */
