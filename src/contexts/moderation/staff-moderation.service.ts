/**
 * Planned component: StaffModerationService
 * Kind: Application Service for exact staff intent
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Admit authenticated staff sanctions through a model-independent path using the same durable
 * effect lifecycle as automatic moderation.
 *
 * Scope:
 * Explicit kick is scope-dependent. Single-target actions do not acquire the optional broad-plan
 * approval requirement.
 *
 * Planned methods:
 * - requestBan: Input: verified staff request, exact target and explicit reason/options. Output:
 *   action intent or denial. Preserve the requested operation, validate current authority and
 *   delegate durable preparation to BanService.
 * - requestKick: Input: verified explicit kick request and exact target. Output: kick intent or
 *   denial when this feature ships. Do not upgrade a kick to a ban or infer a target from context.
 * - requestUnban: Input: verified exact unban request and persisted account/case reference.
 *   Output: unban intent or denial. Resolve the account even if it is no longer a guild
 *   member and delegate to BanService.
 *
 * Collaborators/Boundaries:
 * Uses private moderation records and owner-controlled MikroORM queries, Administration public
 * authority/safety APIs, Jobs/Usage/Audit and narrow Discord or artifact operations as needed.
 * Never queries personal Memory or invokes provider SDKs. Participates in the caller's fresh ORM
 * context; no independent nested commits.
 *
 * Invariants:
 * Actor/target/source come from authenticated request data, not model output, quoted text or
 * display names. Store staff-request origin separately from policy authority. A ban does not imply
 * deleting message history. A staff unban does not change the original accepted findings.
 */
