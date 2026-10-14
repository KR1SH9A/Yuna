/**
 * Planned component: ActionAttempt
 * Kind: Context-private entity
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Track one dispatch claim and what is actually known about its external request.
 *
 * Planned fields:
 * id; guildId; actionId; attemptNumber; dispatchGeneration; claimedAt; sentAt if known;
 * completedAt; requestFingerprint; responseClass; providerRequestReference if available;
 * reconciliationEvidence; revision.
 *
 * Planned methods:
 * - markSent: Input: matching generation and known send metadata. Output: recorded send fact;
 *   absence of this timestamp after a crash is not proof nothing was sent.
 * - recordResponse: Input: matching generation, normalized response and completion time. Output:
 *   response facts and outcome evidence.
 * - recordReconciliation: Input: attributable external evidence and observation time. Output:
 *   additional resolution evidence without rewriting the original request.
 *
 * Collaborators/Boundaries:
 * Private context-owned persistence record. The owning service loads and persists it through
 * MikroORM in the caller's transaction. Transition methods operate on supplied values only; they
 * do not query, enqueue, or call external systems.
 *
 * Invariants:
 * Dispatch claim, request acknowledgment and actual effect are different facts. Preserve ambiguity
 * and reject late stale-attempt writes. Tenant references must remain in one guild through
 * database-enforced constraints. Internal IDs are UUIDs; Discord IDs are strings. Row revision and
 * conditional writes protect mutable transitions; entity checks alone do not replace concurrency
 * constraints.
 */
