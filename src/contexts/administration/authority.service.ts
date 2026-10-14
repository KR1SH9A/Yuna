/**
 * Planned component: AuthorityService
 * Kind: Application Service
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Evaluate separate staff-request and automatic-policy authority against current trusted bindings,
 * and maintain baseline grant revocation.
 *
 * Planned methods:
 * - evaluateStaffRequest: Input: authenticated actor/source, exact operation/target, scoped grant
 *   and current Discord facts. Output: allowed/denied evaluation, reasons and revision binding;
 *   require current native permission and target eligibility.
 * - evaluatePolicyAuthority: Input: trusted enabled policy values, accepted decision/evidence
 *   binding, exact target and current Discord facts. Output: current policy-authority evaluation.
 *   The offender is the target, not the actor supplying permission.
 * - validateGrantRevision: Input: guild/principal/operation and expected grant revision in the
 *   caller transaction. Output: current validity or stale/revoked/expired denial.
 * - revokeGrant: Input: authorized revocation, grant and expected authority revision. Output:
 *   revoked grant and updated binding. Invalidate affected undispatched work through
 *   owner-controlled mechanisms in the same local transaction where required. This baseline
 *   operation is available even when optional governance is disabled; future dispatch rechecks
 *   current authority.
 *
 * Collaborators/Boundaries:
 * Use Administration-owned records and infrastructure only. Current Discord facts arrive through
 * narrow contracts. Do not import another business context; composition-root handlers route
 * approved operations to their feature owner. Nested mutations join the caller transaction.
 *
 * Invariants:
 * No authority derives from names, prose, memory or model output. The feature owner supplies
 * accepted decision values; Administration does not choose findings. Native Discord permission
 * alone does not enroll staff.
 */
