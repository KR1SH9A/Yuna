/**
 * Planned component: WarningService
 * Kind: Message effect coordinator
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Deliver a supported-suspicion warning through the configured permitted destination and record
 * actual delivery independently of the policy decision.
 *
 * Planned methods:
 * - prepareWarning: Input: current finding supporting the rule's suspicion criteria and delivery
 *   policy. Output: deduplicated warning intent keyed by guild, subject, incident and rule.
 *   Failure alone cannot create this intent.
 * - dispatch: Input: warning intent ID. Output: delivery attempt/outcome. Revalidate causal
 *   bindings, safety and audience; select permitted DM or minimal fallback and send outside the
 *   transaction.
 * - recordOutcome: Input: bound attempt and response/message ID. Output: confirmed delivery,
 *   definitive failure or unknown. Record failures without turning them into stronger moderation
 *   findings.
 * - reconcile: Input: unresolved warning and message-specific evidence. Output: confirmed message
 *   or unresolved status under an explicit retry policy. Avoid duplicate notices when a message ID
 *   is unavailable.
 * - recoverDueActions: Input: bounded guild/time/batch criteria. Output: recovery progress and
 *   unresolved references. Select owned warning intents; dispatch eligible ready work under
 *   current gates and reconcile ambiguous deliveries under the configured retry policy.
 *
 * Collaborators/Boundaries:
 * Uses private moderation records and owner-controlled MikroORM queries, Administration public
 * authority/safety APIs, Jobs/Usage/Audit and narrow Discord or artifact operations as needed.
 * Never queries personal Memory or invokes provider SDKs. Participates in the caller's fresh ORM
 * context; no independent nested commits.
 *
 * Invariants:
 * Warning delivery does not require ban permission/hierarchy. Failure to deliver cannot escalate
 * to a ban. Sensitive evidence stays out of public fallback text; interaction-only private
 * responses are not available to ordinary channel messages.
 */
