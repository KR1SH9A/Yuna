/**
 * Planned component: AdministrationContracts
 * Kind: Plain boundary contract catalogue
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the public serialized data boundary. Planned plain boundary types:
 * StaffRequestAuthority: authenticated actor, exact operation/target, source request, grant and
 * installation revisions.
 * PolicyAuthority: trusted system executor, enabled policy/rule revision, accepted decision and
 * evidence binding; target is separate.
 * AuthorityEvaluation: allowed/denied decision, reasons, scope and validity revisions.
 * SafetyGate: guild pause state and monotonic safety revision.
 * InstallationView: guild lifecycle state and installation generation.
 * UsagePolicySnapshot: versioned limits, windows and spend values; contains no usage counters.
 * ApprovedPlanBinding: exact immutable operation hash, scope, expiry, eligible approvals and
 * consumption identity.
 *
 * Scope:
 * Approval and enrollment boundary values are scope-dependent; single-target staff sanctions do
 * not silently gain a multi-approval requirement.
 *
 * Planned methods:
 * No business methods planned. These are conceptual data shapes, not runtime services,
 * declarations or implementations.
 *
 * Collaborators/Boundaries:
 * Plain public authorization, installation, safety and optional governance data. Other contexts
 * supply rule values and exact operations without exporting their entities.
 *
 * Invariants:
 * Authority does not come from display names, message content, model output or memory.
 * Administration never imports business contexts to discover policy or execute their operations.
 */
