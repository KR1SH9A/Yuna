/**
 * Planned component: StaffModerationService
 * Kind: Application Service for exact staff intent
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Admit authenticated staff sanctions through a model-independent path using the
 * same durable effect lifecycle as automatic moderation.
 *
 * Scope: Explicit kick is scope-dependent. Single-target actions do not acquire the optional
 * broad-plan approval requirement.
 *
 * Planned methods:
 * - requestBan: Input: TrustedCallerContext and BanRequestDto. Output: StaffSanctionResultDto.
 *   Preserve the exact requested operation/target, validate current authority and delegate durable
 *   preparation to BanService.
 * - requestKick: Input: TrustedCallerContext and KickRequestDto. Output: StaffSanctionResultDto
 *   when this feature ships. Require the exact kick intent/target; do not upgrade it to a ban or
 *   infer a target from context.
 * - requestUnban: Input: TrustedCallerContext and UnbanRequestDto. Output: StaffSanctionResultDto.
 *   Resolve the exact persisted account/case reference even when the account is no longer a guild
 *   member, validate current authority and delegate to BanService.
 *
 * Collaborators/Boundaries: Uses private moderation records and owner-controlled MikroORM queries,
 * Administration public authority/safety APIs, Jobs/Usage/Audit and narrow Discord or artifact
 * operations as needed. Never queries personal Memory or invokes provider SDKs. Participates in
 * the caller's fresh ORM context; no independent nested commits.
 *
 * DTO ownership: Use dto/staff-sanction.dto.ts. TrustedCallerContext from Administration is
 * verified caller provenance, not authority. Bot ingress maps verified Discord
 * InteractionContextDto plus the loaded installation generation into that context and validates
 * feature arguments separately. Services consume those plain values and normalized source
 * provenance, never bot application types or Discord SDK objects. Authentication fields and
 * validated arguments never replace a freshly checked StaffRequestAuthority.
 *
 * Persistence ownership: use native MikroORM repositories/EntityManager for the private entities
 * registered by ModerationModule. Canonical-case lookup and bounded action/reconciliation queries
 * stay as owner-private query functions. No custom repository is justified yet; do not wrap
 * generic ORM CRUD.
 *
 * Invariants: Actor/target/source come from authenticated request data, not model output, quoted
 * text or display names. Store staff-request origin separately from policy authority. A ban does
 * not imply deleting message history. A staff unban does not change the original accepted
 * findings.
 */
