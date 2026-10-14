/**
 * Planned component: DebateContracts
 * Kind: Plain boundary contract catalogue
 * Owner: Debates
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe trusted source bindings and internal/shared Debates values. Interaction requests and
 * public responses live in dto/debate-session.dto.ts and dto/debate-result.dto.ts; do not duplicate
 * them here. Planned plain boundary types:
 * TranscriptSourceInput: attributable source, author, order and revision/change markers.
 * FrozenEvaluationBinding: session, frozen transcript hash/revision, rubric revision and expected
 * task.
 *
 * Scope:
 * Staged until debate mode ships.
 *
 * Planned methods:
 * No business methods planned. These are conceptual data shapes, not runtime services,
 * declarations or implementations.
 *
 * Collaborators/Boundaries:
 * Plain internal values for trusted transcript intake and task completion. Interactive methods
 * consume Administration's transport-neutral TrustedCallerContext separately from DTO arguments;
 * Debates resolves current session/participant authority itself. Scoring values describe argument
 * evaluation only. Public response DTOs are projections, not accepted task results or authority.
 *
 * Invariants:
 * Never reuse a pruned conversation buffer as the declared transcript. No score or winner result
 * can grant capability or authorize a sanction.
 */
