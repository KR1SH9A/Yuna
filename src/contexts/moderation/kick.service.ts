/**
 * Explicit kick coordination is implemented in the existing moderation owners rather than a
 * separate KickService wrapper. This preserves the shared target gate across all sanctions.
 *
 * Method mapping:
 * - prepareKick: StaffModerationService.requestKick admits an exact authenticated staff request,
 *   rechecks current native/app authority, and commits immutable READY intent and audit together.
 * - dispatch: ActionExecutionService.dispatch reads current native permissions/membership and
 *   hierarchy, commits one consumed remove_guild_member attempt, then calls Discord outside SQL.
 * - recordOutcome: ActionExecutionService.recordOutcome privately fences the owned attempt and
 *   atomically records observed truth, target-gate disposition and audit, including late outcomes.
 * - reconcile: ActionExecutionService.reconcile accepts exact attempt-bound Discord audit evidence;
 *   membership absence alone cannot establish that Yuna kicked the target.
 * - recoverDueActions: ActionExecutionService.recoverDueActions rotates bounded installation-scoped
 *   READY and unresolved batches, rechecking authority or reconciling without a blind retry.
 *
 * DiscordModerationTransport.execute owns the planned kickMember adapter. A 204 response confirms
 * the attempt without inventing an external action ID; ambiguous outcomes retain the target gate.
 * Kick admission is explicit staff-only. These methods do not register a Discord command or enable
 * a live kick workflow, and do not translate a kick into a ban or acquire provider/job dependencies.
 */
