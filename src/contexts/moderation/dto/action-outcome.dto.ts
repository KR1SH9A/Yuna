/**
 * Planned component: Moderation action result DTOs
 * Kind: Use-case input/output DTO catalogue
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Expose bounded serialized effect results to existing dispatch/recovery callers
 * without returning private actions or attempts.
 *
 * Scope: Existing text use cases only; no additional product operations are introduced.
 *
 * Planned DTOs and fields:
 * - ModerationActionOutcomeDto (output): Action reference, operation kind, local lifecycle state,
 *   separate operation result, optional confirmed external message/request reference, unresolved
 *   status and minimal permitted reason/attribution summary. Exclude raw evidence and internal
 *   credentials.
 * - ModerationRecoveryResultDto (output): Bounded processed/deferred counts and unresolved action
 *   references with summarized outcomes for the requested recovery scope.
 *
 * Runtime validation: Check output identifiers, operation/lifecycle labels and conditional fields
 * against the owner-recorded outcome. A message reference exists only when established; unknown
 * outcomes cannot be serialized as success. Ban/unban/kick may be confirmed by 204 without any
 * returned external action ID; do not invent one from a local audit correlation. Recovery results
 * are bounded and scoped to the trusted guild/installation
 * scheduling request.
 *
 * Planned methods: No business methods or queries planned. These comments describe plain
 * input/output data; validation implementation and its library are not chosen.
 *
 * Receiving/returning services: Concrete action services produce these DTOs. Dispatch/reconcile
 * continue receiving a trusted action ID and owner-loaded state; recordOutcome receives the
 * existing normalized DiscordOperationResult plus attempt binding. Recovery retains ordinary
 * bounded internal criteria, without a wrapper DTO for every argument.
 *
 * Collaborators/Boundaries: The trusted caller scope and attempt generation are not inferred from
 * output fields. Private ModerationAction, ActionAttempt and TargetExecutionState stay inside
 * Moderation. No generic executor or new effect lifecycle is introduced.
 *
 * Trusted caller contract: User-invoked operations receive Administration TrustedCallerContext
 * separately from the feature DTO. It records verified provenance, not permission. System
 * completion/recovery calls instead use stored owner-bound references and trusted scheduling
 * scope. No parallel per-feature caller shape is defined.
 */
