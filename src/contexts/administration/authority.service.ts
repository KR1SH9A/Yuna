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
 * - bootstrapOwner: Input: verified current guild owner and exact installation. Output: idempotent
 *   owner enrollment/grant for this generation under the selected baseline authority policy.
 * - grantCapability: Input: authorized grant request, exact installation/scope and verified current
 *   authority. Output: immutable grantee/capability/scope grant with replay identity; changes replace.
 * - evaluateStaffRequest: Input: separate TrustedCallerContext, exact operation/target, scoped
 *   grant and verified current Discord facts. Output: AuthorityEvaluation with allowed/denied
 *   decision, reasons and revision binding;
 *   require current native permission and target eligibility.
 * - evaluatePolicyAuthority: Input: trusted enabled policy values, accepted decision/evidence
 *   binding, exact target and current Discord facts. Output: current policy-authority evaluation.
 *   The offender is the target, not the actor supplying permission.
 * - validateGrantRevision: Input: guild/principal/operation and expected grant revision in the
 *   caller transaction. Output: current validity or stale/revoked/expired denial.
 * - revokeGrant: Input: RevokeGrantRequestDto plus separate TrustedCallerContext and verified
 *   current authority facts. Output: GrantRevocationResponseDto. Load and authorize the scoped
 *   grant before revoking it and projecting the updated revision. Invalidate affected
 *   undispatched work through owner-controlled mechanisms in the same local transaction where
 *   required. This baseline
 *   operation is available even when optional governance is disabled; future dispatch rechecks
 *   current authority.
 *
 * Collaborators/Boundaries:
 * Own native MikroORM queries/persistence for Administration records; no custom repository layer
 * is implied. Request/response DTOs live in dto/grant-revocation.dto.ts; trusted bindings remain
 * in contracts.ts. Current Discord facts arrive through narrow verified contracts, separately
 * from request fields. Do not import another business context; composition-root handlers route
 * approved operations to their feature owner. Nested mutations join the caller transaction.
 *
 * Invariants:
 * No authority derives from names, prose, memory or model output. The feature owner supplies
 * accepted decision values; Administration does not choose findings. Native Discord permission
 * alone does not enroll staff.
 */
