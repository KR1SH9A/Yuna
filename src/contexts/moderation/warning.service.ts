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
 *   warning intent keyed by guild, subject, incident and rule. Failure alone cannot create this
 *   intent.
 * - dispatch: Input: trusted warning intent reference. Output: ModerationActionOutcomeDto.
 *   Revalidate owned causal bindings, safety and audience; choose the permitted DM/minimal
 *   fallback and send outside the transaction.
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
 * Collaborators/Boundaries: Uses private moderation records and owner-controlled MikroORM queries,
 * Administration public authority/safety APIs, Jobs/Usage/Audit and narrow Discord or artifact
 * operations as needed. Never queries personal Memory or invokes provider SDKs. Participates in
 * the caller's fresh ORM context; no independent nested commits.
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
 * private responses are not available to ordinary channel messages.
 */
