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
 * None. Future types describe TaskDescriptor, TaskRegistration, TaskClaim, PreparedInputRelease,
 * StoredResultReference, AcceptanceBinding and WorkInvalidation. The queue-facing TaskSignalDto
 * is defined in dto/task-signal.dto.ts. Capability-specific payload/result schemas remain under
 * src/ai/contracts; do not duplicate them as entity-shaped DTOs.
 * TaskDescriptor is the minimal stored routing view: task ID, installationId/guildId, owner,
 * operation/workflow reference, kind/schema version and deadline. It contains no input/result payload, artifact
 * handles or credentials, and grants neither a claim nor permission to accept a result.
 *
 * Planned fields:
 * Trusted immutable installationId/guildId, owner and operationKey; optional workflow/stage;
 * current expected task identity; task/attempt
 * generation; versioned input/result schema; relevant evidence, policy, privacy, audience,
 * installation and cancellation revisions; sourceUse (original_evidence, current_source or none);
 * deadline; opaque references. An optional installation generation accompanies, never replaces,
 * immutable installation identity.
 *
 * Boundaries/invariants:
 * No live ORM entities cross this boundary. IDs and routing are server-owned. An acceptance
 * binding identifies the currently expected task, not only a stage name. One terminal result per
 * task distinguishes success, uncertain, failure, canceled and expired. One acceptance per result
 * distinguishes accepted from discarded; Jobs assigns no business meaning. A failure can be
 * accepted when the owner applies its failure disposition. Source edits alone do not invalidate
 * original_evidence, while current_source requires currentness. Credentials and interaction tokens
 * are excluded from all task/input/result/signal contracts.
 * Worker claims do not authorize disclosure: a separate release gate checks eligibility.
 */
