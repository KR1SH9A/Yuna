/**
 * Planned component: BanService
 * Kind: Effect coordinator with durable command and state machine
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Coordinate attributable ban/unban intent, dispatch and reconciliation while serializing
 * conflicting work for one target across cases and staff actions.
 *
 * Planned methods:
 * - prepareBan: Input: accepted causal findings and policy authority, or exact staff authority.
 *   Output: deduplicated READY ban intent. Persist target/evidence/policy bindings and coalesce
 *   findings for one logical case action.
 * - prepareUnban: Input: exact authenticated staff operation and current authority. Output: READY
 *   unban intent bound to the guild/account and staff request. A Yuna case alone is not authority
 *   to remove a ban; retain action attribution for dispatch and reconciliation.
 * - dispatch: Input: action ID. Output: recorded outcome or unresolved attempt. Read current
 *   Discord facts outside the transaction; atomically lock safety/target state, revalidate
 *   bindings and claim; call Discord after commit.
 * - recordOutcome: Input: action/attempt generation and normalized response/evidence. Output:
 *   updated lifecycle/result. Separate applied, already present, denied and unresolved outcomes;
 *   retain ambiguous sends.
 * - reconcile: Input: unresolved action and available attempt/audit/current-ban evidence. Output:
 *   confirmed attribution, definitive failure or continued uncertainty. Resolve the old executor
 *   before any permitted redispatch.
 * - recoverDueActions: Input: bounded guild/time/batch criteria. Output: recovery progress and
 *   unresolved references. Select due ban/unban work with private owner queries; dispatch eligible
 *   ready intents under current gates and reconcile dispatched or unknown attempts without blind
 *   resends.
 *
 * Collaborators/Boundaries:
 * Uses private moderation records and owner-controlled MikroORM queries, Administration public
 * authority/safety APIs, Jobs/Usage/Audit and narrow Discord or artifact operations as needed.
 * Never queries personal Memory or invokes provider SDKs. Participates in the caller's fresh ORM
 * context; no independent nested commits.
 *
 * Invariants:
 * Ban and unban share TargetExecutionState. Lease expiry never authorizes another destructive
 * call. Ban presence/absence alone proves neither attribution nor a safe reversal. Unknown effects
 * hold conflicting work. Current safety/authority and action limits are rechecked at dispatch; a
 * pause cannot recall a request already in flight.
 */
