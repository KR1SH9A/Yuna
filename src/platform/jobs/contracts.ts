/**
 * Planned component: Jobs contracts
 * Kind: Plain infrastructure boundary types and serialized record schemas
 * Owner: Platform / Jobs
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe task registration, execution claims, controlled input release, persisted results,
 * acceptance acknowledgments, invalidation and delivery signals.
 *
 * Planned methods:
 * None. Future types describe TaskRegistration, TaskClaim, PreparedInputRelease,
 * StoredResultReference, AcceptanceBinding, WorkInvalidation and TaskSignal. Capability-specific
 * payload/result schemas remain under AI contracts.
 *
 * Planned fields:
 * Trusted guild, owner, workflow and stage; current expected task identity; task/attempt
 * generation; versioned input/result schema; relevant evidence, policy, privacy, audience,
 * installation and cancellation revisions; deadline; opaque references.
 *
 * Boundaries/invariants:
 * No live ORM entities cross this boundary. IDs and routing are server-owned. An acceptance
 * binding identifies the currently expected task, not only a stage name. Success, uncertainty and
 * failure remain distinct; Jobs assigns no business meaning.
 * Worker claims do not authorize disclosure: a separate release gate checks eligibility.
 */
