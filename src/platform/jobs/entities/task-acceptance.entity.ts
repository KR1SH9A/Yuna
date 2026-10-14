/**
 * Planned component: TaskAcceptance
 * Kind: Immutable acceptance or rejection acknowledgment
 * Owner: Platform / Jobs
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Record the owner's decision about a stored result without owning that decision.
 *
 * Planned methods:
 * None. TaskService records the context-supplied acknowledgment in its transaction.
 *
 * Planned fields:
 * Acceptance ID; guild/task/result identity; owner workflow; stage; current expected task binding
 * and relevant revision/generation references; accepted/rejected status; rejection reason;
 * timestamp.
 *
 * Boundaries/invariants:
 * At most one accepted completion per expected task. Do not make workflow/stage
 * alone unique: evidence edits or reassessment can repeat a stage with a new task. The owner
 * verifies that its expected task and revision remain current, records this acknowledgment and
 * changes its workflow in the same short transaction. Technical retries and duplicate completion
 * signals cannot advance a stage twice. No provider call or business decision is performed by this
 * record.
 */
