/**
 * Planned component: ModerationCase
 * Kind: Context-private entity
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Own one canonical incident and its expected AI stage while keeping workflow progress separate
 * from evidential disposition.
 *
 * Planned fields:
 * id; guildId; subjectUserId; incidentKey; workflowPhase; disposition; currentEvidenceRevision;
 * policyRevision; expectedTaskId; generation; revision; createdAt; updatedAt.
 *
 * Planned methods:
 * - replaceEvidenceRevision: Input: new retained evidence reference and expected revision. Output:
 *   advanced local evidence/generation binding; make previous task/finding assumptions stale.
 * - expectTask: Input: task ID, stage and current evidence/policy binding. Output: next
 *   expected-stage state. Reject incompatible progression.
 * - acceptFinding: Input: validated current task/result and finding reference. Output: accepted
 *   finding linkage only for the expected stage and revisions.
 * - recordDisposition: Input: accepted policy disposition and causal finding references. Output:
 *   updated business outcome without claiming an external effect succeeded.
 *
 * Collaborators/Boundaries:
 * Private context-owned persistence record. The owning service loads and persists it through
 * MikroORM in the caller's transaction. Transition methods operate on supplied values only; they
 * do not query, enqueue, or call external systems.
 *
 * Invariants:
 * Unique guild/subject/incident identity is enforced in storage. Edited content creates a new
 * revision rather than a new incident. No duplicate accepted completion; late results cannot
 * advance a different stage. Tenant references must remain in one guild through database-enforced
 * constraints. Internal IDs are UUIDs; Discord IDs are strings. Row revision and conditional
 * writes protect mutable transitions; entity checks alone do not replace concurrency constraints.
 */
