/**
 * Planned component: TaskAttempt
 * Kind: Durable technical execution-attempt record
 * Owner: Platform / Jobs
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Track one claim, provider execution and result-persistence opportunity for a task.
 *
 * Planned methods:
 * None. WorkerTaskStore and TaskRecoveryService perform conditional transitions.
 *
 * Planned fields:
 * Attempt ID; guild/task identity; attempt number; generation; lease owner/deadline;
 * claimed/start/end times; input-release metadata; provider request reference; retry/failure
 * classification; usage reference; current execution state; row revision.
 *
 * Boundaries/invariants:
 * Claim generation is compared on renewal and result writes. A superseded worker cannot overwrite
 * the current attempt's result or extend its own stale lease. Attempt retries do not change
 * business evidence, policy or expected-task identity. A timeout or expired lease does not
 * establish that provider work stopped or was free. Do not store moderation action attempts here;
 * those belong to Moderation.
 */
