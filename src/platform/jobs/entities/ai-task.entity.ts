/**
 * Planned component: AiTask
 * Kind: Jobs-owned persistent task entity with immutable execution binding
 * Owner: Platform / Jobs
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Identify one bounded inference task independently of a provider or delivery attempt.
 *
 * Planned methods:
 * None. TaskService and restricted WorkerTaskStore operations coordinate persistence.
 *
 * Planned fields:
 * Task ID; guild ID; kind and schema version; owner context; workflow ID; stage; prepared-input
 * reference/hash; required revision bindings; provider configuration, model and prompt versions;
 * deadline; technical lifecycle status; creation/update time; mutable row revision and current
 * execution generation where needed.
 *
 * Boundaries/invariants:
 * Identity, input, owner and revision binding cannot be rewritten by a worker. Lifecycle changes
 * do not replace the immutable binding. Reassessment uses a new expected task; a technical retry
 * creates another attempt of this task. The context owns its expected-task pointer and business
 * stage meaning. Guild-scoped constraints prevent cross-tenant task/input/result relationships. No
 * provider, queue or business workflow methods live on this entity.
 */
