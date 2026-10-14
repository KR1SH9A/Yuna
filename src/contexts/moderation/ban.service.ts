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
 *   describing the deduplicated READY intent. Persist target/evidence/policy bindings and coalesce
 *   findings for one logical case action.
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
 *   Output: ModerationRecoveryResultDto. Select due ban/unban work using private owner queries;
 *   dispatch eligible ready intents under current gates and reconcile dispatched/unknown attempts
 *   without blind resends.
 *
 * Collaborators/Boundaries: Uses private moderation records and owner-controlled MikroORM queries,
 * Administration public authority/safety APIs, Jobs/Usage/Audit and narrow Discord or artifact
 * operations as needed. Never queries personal Memory or invokes provider SDKs. Participates in
 * the caller's fresh ORM context; no independent nested commits.
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
 * Invariants: Ban and unban share TargetExecutionState. Lease expiry never authorizes another
 * destructive call. Ban presence/absence alone proves neither attribution nor a safe reversal.
 * Unknown effects hold conflicting work. Current safety/authority and action limits are rechecked
 * at dispatch; a pause cannot recall a request already in flight.
 */
