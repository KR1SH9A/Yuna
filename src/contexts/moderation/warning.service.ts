/**
 * Planned component: WarningService
 * Kind: Message effect coordinator
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Deliver a supported-suspicion warning through the configured permitted
 * destination and record actual delivery independently of the policy decision.
 *
 * Planned methods:
 * - prepareWarning: Input: current internally accepted finding supporting the suspicion criteria
 *   and configured delivery policy. Output: ModerationActionOutcomeDto describing a deduplicated
 *   warning intent keyed by guild/installation, subject, original incident and rule. Retain the
 *   exact warning text, mention policy, permitted destination/fallback and correlation reference
 *   in the owner record. Failure alone cannot create this intent.
 * - dispatch: Input: trusted warning intent reference. Output: ModerationActionOutcomeDto.
 *   Revalidate owned original-evidence bindings, safety and audience; resolve only an authorized
 *   DM/minimal fallback, persist its exact request in the claim and send after commit. Never use
 *   fallback as a second send while the first outcome remains unknown.
 * - recordOutcome: Input: owned attempt binding plus normalized DiscordOperationResult and message
 *   evidence. Output: ModerationActionOutcomeDto. Record confirmed delivery, definitive failure or
 *   unknown without converting failure into a stronger finding.
 * - reconcile: Input: trusted unresolved warning reference and message-specific evidence. Output:
 *   ModerationActionOutcomeDto. Confirm attributable delivery or retain uncertainty under the
 *   explicit retry policy; avoid duplicate notices without an established message ID.
 * - recoverDueActions: Input: bounded internal guild/time/batch criteria from trusted scheduling.
 *   Output: ModerationRecoveryResultDto. Select private owned intents, dispatch eligible ready
 *   work under current gates and reconcile ambiguous deliveries under configured policy.
 *
 * Transaction contract: prepareWarning and recordOutcome join/start a short local transaction
 * without remote I/O. dispatch, reconcile and recoverDueActions enter outside active transactions;
 * coordinate audience reads and sends around short claim/outcome transactions. No independent
 * nested commits. Recovery uses a fresh ORM context and explicit guild/installation scope.
 *
 * Collaborators/Boundaries: Uses private moderation records, Administration authority/safety APIs,
 * Audit and narrow Discord reads/sends. Warning delivery has no automatic provider-accounting or
 * Jobs dependency; accepted content and causal bindings are already owned by Moderation.
 *
 * DTO ownership: Use dto/action-outcome.dto.ts for serialized outcomes. Preparation and outcome
 * recording are internal owner operations over accepted findings and adapter values, not public
 * message fields.
 *
 * Persistence ownership: use native MikroORM repositories/EntityManager for the private entities
 * registered by ModerationModule. Canonical-case lookup and bounded action/reconciliation queries
 * stay as owner-private query functions. No custom repository is justified yet; do not wrap
 * generic ORM CRUD.
 *
 * Invariants: Warning delivery does not require ban permission/hierarchy. Failure to deliver
 * cannot escalate to a ban. Sensitive evidence stays out of public fallback text; interaction-only
 * private responses are not available to ordinary channel messages. Edits/deletion do not replace
 * original evidence or revoke its work solely because the source changed. Returned message ID is
 * recorded when known; any nonce is at most 25 characters and only offers Discord's bounded recent
 * deduplication, not indefinite retry safety.
 */
