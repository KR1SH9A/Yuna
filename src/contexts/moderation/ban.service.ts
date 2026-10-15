/**
 * Planned component: BanService
 * Kind: Effect coordinator with durable command and state machine
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Coordinate attributable ban/unban intent, dispatch and reconciliation while
 * serializing conflicting work for one target across cases and staff actions.
 *
 * Planned methods:
 * - prepareBan: Input: accepted causal findings and PolicyAuthority, or exact
 *   StaffRequestAuthority supplied by the owning workflow. Output: ModerationActionOutcomeDto
 *   describing the deduplicated READY intent. Persist immutable guild/installation identity,
 *   exact account/options payload, correlation reference and exclusive policy/staff origin.
 *   Policy origin names accepted original-evidence/full-policy bindings; coalesce its findings.
 *   Persist or verify retained original details and accepted reasons, then bind the ban to their
 *   exact records in the same transaction. Only committed intent can proceed to dispatch.
 * - prepareUnban: Input: exact internally authorized staff operation and current
 *   StaffRequestAuthority. Output: ModerationActionOutcomeDto describing READY unban intent bound
 *   to the guild/account and staff request. A Yuna case alone is not authority to remove a ban;
 *   retain attribution for dispatch and reconciliation.
 * - dispatch: Input: trusted action reference. Output: ModerationActionOutcomeDto. Load owned
 *   state, read current Discord facts outside the transaction, atomically lock safety/target
 *   state, revalidate bindings and claim, then call the adapter after commit.
 * - recordOutcome: Input: owned action/attempt generation plus the normalized
 *   DiscordOperationResult and attribution evidence from the adapter. Output:
 *   ModerationActionOutcomeDto. Separate applied, already present, denied and unresolved outcomes;
 *   retain ambiguous sends.
 * - reconcile: Input: trusted unresolved action reference and available attempt/audit/current-ban
 *   evidence. Output: ModerationActionOutcomeDto with confirmed attribution, definitive failure or
 *   continued uncertainty. Resolve the old executor before any permitted redispatch.
 * - recoverDueActions: Input: bounded internal guild/time/batch criteria from trusted scheduling.
 *   Output: ModerationRecoveryResultDto. Select due guild/installation work using private queries;
 *   dispatch eligible ready intents under current gates and reconcile dispatched/unknown attempts
 *   without blind resends.
 *
 * Transaction contract: prepareBan, prepareUnban and recordOutcome are local operations: join the
 * caller's transaction or start a short one, with no remote I/O. dispatch, reconcile and
 * recoverDueActions enter outside an active transaction and coordinate remote reads/calls around
 * short claims/outcome transactions. Reject an orchestration call inside a caller transaction;
 * no independent nested commits. Each recovery batch uses a fresh ORM context.
 *
 * Collaborators/Boundaries: Uses private moderation records, Administration authority/safety APIs,
 * Audit and narrow Discord reads/effects. Add a collaborator only for an operation this service
 * actually performs; no automatic Jobs/Usage/provider dependency for native moderation effects.
 *
 * DTO ownership: Serialized results are defined in dto/action-outcome.dto.ts. Internal
 * preparation, claim and normalized adapter inputs remain narrow owner-bound values; a public
 * staff argument DTO is not an execution authorization. No DTO per internal helper argument is
 * required.
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
 * Invariants: Ban and unban share TargetExecutionState. Lease expiry never authorizes another
 * destructive call. Ban presence/absence alone proves neither attribution nor a safe reversal.
 * Unknown effects hold conflicting work. Current safety/authority and action limits are rechecked
 * at dispatch; a pause cannot recall a request already in flight. Current-source edits/deletion do
 * not revoke original_evidence bindings. Account targets need not be current guild members.
 * Ban/unban 204 success has no returned action ID; exact audit correlation supports reconciliation
 * but is not itself proof of application. Message-history deletion is zero unless explicitly
 * authorized in the immutable payload. Reinstall cannot bypass an older unresolved target action.
 */
