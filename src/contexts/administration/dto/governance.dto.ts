/**
 * Planned component: GovernanceDtos
 * Kind: Staged external request and public response DTO catalogue
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Group related optional plan, approval and enrollment interaction shapes.
 *
 * Scope:
 * Staged with optional multi-custodian governance. These shapes do not activate a workflow or
 * impose quorum requirements on baseline grant revocation or ordinary staff operations.
 *
 * Planned shapes:
 * - ProposePlanRequestDto: inbound bounded exact requested operations, target scope and expiry;
 *   consumed by GovernanceService.proposePlan.
 * - ApprovePlanRequestDto: inbound exact plan reference and expected plan hash; consumed by
 *   GovernanceService.approvePlan. The approver is the separately authenticated caller.
 * - EnrollCustodianRequestDto: inbound exact candidate and enrollment scope/reference; consumed
 *   by GovernanceService.enrollCustodian. The candidate is a target, not the caller by default.
 * - GovernancePlanResponseDto: outbound authorized view of plan reference, immutable hash,
 *   requested operation summary, scope, expiry and current approval/consumption progress;
 *   produced by proposePlan and approvePlan.
 * - CustodianEnrollmentResponseDto: outbound enrollment/candidate reference and pending,
 *   rejected or completed outcome; produced by enrollCustodian.
 *
 * Planned methods:
 * None. Future DTO validation checks supported operation shapes and bounded values only.
 *
 * Boundaries/invariants:
 * TrustedCallerContext is separate. Requests cannot set proposer/approver authority, eligible
 * approval counts, candidateAcceptedAt or resulting grants. Candidate acceptance must be
 * independently authenticated for the exact scope; another caller cannot assert it. Services
 * load current plan/grant/enrollment records and project permitted response values. These
 * responses never substitute for the internal one-time ApprovedPlanBinding in ../contracts.ts.
 */
