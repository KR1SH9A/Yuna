# Planned integration checks

No tests or database fixtures are implemented yet. Future checks should exercise real database/queue behavior:

- Workflow state, task, usage reservation, audit and outbox commit or roll back together where required.
- Duplicate delivery and concurrent acceptance advance an expected task only once.
- A legitimate repeated stage after an evidence edit gets a new expected task.
- Worker roles cannot rewrite task ownership/bindings, grants, evidence or sanctions.
- Privacy invalidation serializes with prepared-input release and prevents new disclosure of queued work.
- Late workers cannot overwrite a newer attempt or recreate deleted facts.
- Crashes around publication and result persistence recover from stored state.
- Pause, resume and stale evidence compete correctly with action dispatch.
- Conflicting staff ban/unban requests serialize on the same target while preserving their separate authority and outcomes.
- Timed-out external effects remain unknown until attributable reconciliation permits progress.
- Provider retries and potentially billed timeouts remain accounted for.

Do not keep database transactions open while invoking model providers, Discord or independent artifact storage.
