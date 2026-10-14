/**
 * Planned component: ModerationFinding
 * Kind: Context-private immutable accepted record
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Record an accepted interpretation of exact evidence and rule versions separately from
 * subsequent staff actions and external effect outcomes.
 *
 * Planned fields:
 * id; guildId; caseId; evidenceRevision; ruleId; ruleVersion; observationResultId;
 * assessmentResultId; supportedFacts; exclusions; disposition; acceptedAt.
 *
 * Planned methods:
 * No mutation methods planned. Reassessment records a new finding bound to the current evidence
 * and policy revisions; retain the original accepted record according to its retention policy.
 *
 * Collaborators/Boundaries:
 * Private context-owned persistence record. The owning service loads and persists it through
 * MikroORM in the caller's transaction. No queries, enqueue operations or external calls live on
 * this record.
 *
 * Invariants:
 * Accepted evidence/assessment bindings do not mutate. New automated effects require findings
 * accepted for the case's current evidence and policy bindings; historical findings alone cannot
 * authorize new work. Warnings require supported suspicion rather than a technical failure.
 * Tenant references remain in one guild through database-enforced constraints. Internal IDs are
 * UUIDs; Discord IDs are strings. Staff unban actions do not rewrite the recorded assessment.
 */
