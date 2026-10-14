/**
 * Planned component: AdministrationContracts
 * Kind: Plain boundary contract catalogue
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe trusted caller bindings and internal/shared Administration values. External request
 * and public response shapes live in dto/grant-revocation.dto.ts, dto/guild-safety.dto.ts and
 * staged dto/governance.dto.ts; do not duplicate them here. Planned plain boundary types:
 * TrustedCallerContext: authenticated actorId, guildId, installationGeneration and
 * sourceRequestId. Bot ingress maps verified transport identity plus the loaded installation
 * into this transport-neutral value. It proves provenance only, not permission for an operation;
 * services still validate current installation and authority. It is a separate trusted argument,
 * never hydrated from a request body or imported from the bot app/Discord SDK.
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
 * VerifiedCandidateAcceptance: independently authenticated candidate, exact enrollment scope
 * and accepted source request; supplied separately from another actor's enrollment request.
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
 * Plain shared authorization, installation, safety and optional governance data. Other contexts
 * may consume TrustedCallerContext and the narrow evaluated bindings, and supply rule values and
 * exact operations without exporting entities. Display DTOs are snapshots, not reusable authority.
 *
 * Invariants:
 * Authority does not come from display names, message content, model output or memory.
 * Administration never imports business contexts to discover policy or execute their operations.
 */
