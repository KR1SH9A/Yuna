/**
 * Planned component: ApprovedPlanHandlers
 * Kind: Cross-context application-root coordinator
 * Owner: Bot application
 * Status: Design scaffold only; not implemented. Optional governance scope.
 *
 * Responsibility:
 * Apply an exact approved plan without making Administration import other contexts.
 *
 * Planned methods:
 * - applyApprovedPlan: Load a trusted plan reference; ask GovernanceService to validate/consume
 *   approval and the owning feature to apply its exact operation. Coordinate local changes in one
 *   short transaction where atomicity is required.
 *
 * Invariants:
 * Revalidate plan contents, expiry, approvers and authority revisions. A plan must not gain extra
 * operations during execution. Feature services retain policy ownership; external calls follow
 * persisted intent.
 */
