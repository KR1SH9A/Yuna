/**
 * Planned component: TaskResult
 * Kind: Immutable terminal result record
 * Owner: Platform / Jobs
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Retain a bound provider result independently of queue-job retention and acceptance.
 *
 * Planned methods:
 * None. WorkerTaskStore persists a result; the context accepts it through TaskService.
 *
 * Planned fields:
 * Result ID; guild/task/attempt identity; attempt generation; output schema version; success,
 * uncertainty or failure kind; validated payload or reason/retry category; timing; usage
 * reference; creation and retention metadata.
 *
 * Boundaries/invariants:
 * At most one terminal result per attempt; a superseded generation cannot install a current
 * result. Preserve immutable output while retained under its data lifecycle. Model text cannot
 * supply authoritative owner, guild, subject or operation bindings. Stored success is not business
 * acceptance. Provider uncertainty or failure does not itself justify a warning, sanction, grant
 * or disclosure. A committed result remains discoverable after lost completion notification.
 */
