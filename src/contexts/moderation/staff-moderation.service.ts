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
 * Transaction contract: request methods enter outside an active transaction. Obtain required
 * current Discord facts first; then in one short local transaction revalidate installation,
 * authority and safety, persist exact staff-request origin and call local action preparation.
 * No remote reads inside that transaction and no independent nested commits. Admission is separate
 * from later dispatch and cannot claim remote completion.
 *
 * Collaborators/Boundaries: Uses private moderation records, Administration authority/safety APIs,
 * Audit and narrow Discord reads plus BanService/optional KickService preparation. No automatic
 * Jobs, Usage, personal Memory or provider dependency is needed for explicit native sanctions.
 *
 * DTO ownership: Use dto/staff-sanction.dto.ts. TrustedCallerContext from Administration is
 * verified caller provenance, not authority. Bot ingress maps verified Discord
 * InteractionContextDto plus loaded immutable installationId (UUID) and lifecycle generation into
 * that context and validates feature arguments separately. Services consume plain values and source
 * provenance, never bot application types or Discord SDK objects. Authentication fields and
 * validated arguments never replace a freshly checked StaffRequestAuthority.
 *
 * Persistence ownership: use native MikroORM repositories/EntityManager for the private entities
 * registered by ModerationModule. Canonical-case lookup and bounded action/reconciliation queries
 * stay as owner-private query functions. No custom repository is justified yet; do not wrap
 * generic ORM CRUD.
 *
 * Unban admission requires an explicit request through Yuna from a current Discord administrator.
 * Trusted internal admin proof binds source request, actor, exact target/operation and authorization
 * observation time; public arguments cannot supply it. Recheck native administrator permissions
 * before a new dispatch. AI results, scheduled recovery and governance cannot initiate unbans.
 * Automatic policy bans require no staff review. Recovery may only continue an existing authorized
 * request under current gates; it cannot invent a new unban request.
 *
 * Invariants: Actor/target/source come from authenticated request data, not model output, quoted
 * text or display names. Store staff-request origin separately from policy authority. A ban does
 * not imply deleting message history. A staff unban does not change the original accepted
 * findings. Stored work carries guildId plus immutable installationId; a generation snapshot is
 * only a validity check and never replaces installation identity. Source edits/deletion cannot
 * reinterpret an exact staff request or the original findings.
 */
