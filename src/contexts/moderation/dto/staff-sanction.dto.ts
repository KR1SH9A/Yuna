/**
 * Planned component: Explicit staff sanction DTOs
 * Kind: Use-case input/output DTO catalogue
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Describe the existing exact ban, optional kick and unban use cases without
 * mixing request arguments with authentication or authorization.
 *
 * Unban admission requires an explicit request through Yuna from a current Discord administrator.
 * Trusted internal admin proof binds source request, actor, exact target/operation and authorization
 * observation time; public arguments cannot supply it. Recheck native administrator permissions
 * before a new dispatch. AI results, scheduled recovery and governance cannot initiate unbans.
 * Automatic policy bans require no staff review. Recovery may only continue an existing authorized
 * request under current gates; it cannot invent a new unban request.
 *
 * Scope: Ban/unban are existing operations. KickRequestDto is used only when explicit kicks are
 * released; this file does not enable that feature.
 *
 * Planned DTOs and fields:
 * - BanRequestDto (input): Exact target account reference and bounded explicit reason/options
 *   supported by the existing ban operation. No actor, grant, policy authority or inferred
 *   history-purge instruction. Any supported explicit delete-message-seconds option is bounded by
 *   Discord's accepted range and defaults to zero; it becomes part of the immutable action payload.
 * - KickRequestDto (input; optional scope): Exact target account reference and bounded explicit
 *   kick reason. The receiving method fixes the operation as kick.
 * - UnbanRequestDto (input): Exact persisted account reference or a case reference resolving
 *   exactly one account, with bounded reason. Keep the reference usable when the account is no
 *   longer a guild member.
 * - StaffSanctionResultDto (output): Requested operation, accepted/denied status, optional durable
 *   action reference and minimal authorized reason/progress. Intent acceptance does not report
 *   remote success.
 *
 * Runtime validation: Validate exact reference syntax, allowed operation-specific options and
 * bounded reason. Reject ambiguous/multiple targets and unsupported fields. The ingress parser
 * verifies that direct staff intent was actually expressed; current Yuna/native authority and
 * target eligibility remain service checks. Staff identity and source event come from the separate
 * trusted caller input.
 *
 * Planned methods: No business methods or queries planned. These comments describe plain
 * input/output data; validation implementation and its library are not chosen.
 *
 * Receiving/returning services: StaffModerationService consumes these DTOs and produces
 * StaffSanctionResultDto. BanService and optional KickService receive internal authorized values
 * after that check, rather than reinterpreting a public DTO as authority.
 *
 * Collaborators/Boundaries: Administration owns StaffRequestAuthority; do not redefine it here. No
 * model answer or quoted command can create the trusted caller. Unban is an exact staff action and
 * does not rewrite original accepted findings.
 *
 * Trusted caller contract: User-invoked operations receive Administration TrustedCallerContext
 * separately from the feature DTO. It records verified provenance, not permission. System
 * completion/recovery calls instead use stored owner-bound references and trusted scheduling
 * scope. No parallel per-feature caller shape is defined.
 */
