/**
 * Planned component: TaskRecoveryService
 * Kind: Durable technical recovery coordinator
 * Owner: Platform / Jobs
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Restore progress from database state when queue delivery, workers or completion notifications
 * fail, without deciding what an owning business workflow should do.
 *
 * Planned methods:
 * - recoverExpiredAttempts: bounded due-work selection and current time -> recovery summary. Fence
 *   expired claims; preserve uncertain costs; permit bounded retries only for eligible tasks that
 *   remain nonterminal. A terminal result with purged/unavailable payload goes to owner discard,
 *   never another provider execution. Finalize expired nonterminal tasks with one expired result
 *   and completion outbox.
 * - republishMissingWork: bounded eligible task/outbox selection -> publication work. Restore
 *   missing wake-up signals without duplicating logical tasks or revisions.
 * - redeliverUnacceptedResults: bounded stored-result selection -> completion signals. Redrive bot
 *   routing until the owner records acceptance/discard; reuse persisted results instead of
 *   repeating inference after a result-commit crash.
 *
 * Boundaries/invariants:
 * Recovery enters outside an active transaction, creates fresh ORM contexts for bounded batches
 * and coordinates short local transactions with external publication. Recheck
 * cancellation, current eligibility and deadline before restoring work. No importing contexts,
 * advancing cases, selecting sanctions or resending Discord effects. Business owners reconcile
 * their own ambiguous external outcomes. Lease expiry does not prove that an earlier provider call
 * stopped or was unbilled. A worker-local unsupported kind/version is a routing mismatch, not
 * deployment-wide evidence to PARK a task; fleet capability policy controls unsupported-work
 * parking/resumption. A missing owner acceptor leaves completion pending without reopening inference.
 */
