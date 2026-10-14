/**
 * Planned component: ModerationAction
 * Kind: Context-private entity
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Represent one durable intended external moderation operation and its local lifecycle across
 * attempts.
 *
 * Planned fields:
 * id; guildId; caseId; findingReferences; targetUserId; kind; authorityOrigin/binding;
 * evidenceRevision; policyRevision; deduplicationKey; state; generation; auditReference;
 * operationResult; revision; createdAt; updatedAt.
 *
 * Planned methods:
 * - claimDispatch: Input: verified current gate values and expected generation. Output: DISPATCHED
 *   state and next generation when READY or definitively retryable.
 * - recordOutcome: Input: matching attempt generation and normalized effect result. Output:
 *   confirmed, retryable, permanent-failure or UNKNOWN state with separate result details.
 * - cancelBeforeDispatch: Input: invalidation cause and expected revision. Output: CANCELED state
 *   only before a dispatch claim.
 * - recordReconciliation: Input: attributed reconciliation evidence. Output: resolved lifecycle or
 *   retained UNKNOWN status without fabricating success.
 *
 * Collaborators/Boundaries:
 * Private context-owned persistence record. The owning service loads and persists it through
 * MikroORM in the caller's transaction. Transition methods operate on supplied values only; they
 * do not query, enqueue, or call external systems.
 *
 * Invariants:
 * Logical intent and delivery attempt are separate. Automated intent names accepted findings;
 * staff intent names authenticated authority. Unknown or dispatched effects cannot be treated as
 * safely canceled/resendable by a local lease timeout. Tenant references must remain in one guild
 * through database-enforced constraints. Internal IDs are UUIDs; Discord IDs are strings. Row
 * revision and conditional writes protect mutable transitions; entity checks alone do not replace
 * concurrency constraints.
 */
