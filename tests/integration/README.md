# Entity persistence and planned application checks

`entities.postgres.test.ts` runs against an isolated temporary PostgreSQL cluster. It verifies the core/full schemas, explicit administrator unban provenance, original evidence after job cleanup, scoped constraints, immutable evidence and competing ORM writes. Run it with `npm run test:db`; PostgreSQL `initdb`, `pg_ctl` and `psql` must be on PATH.

Service and queue orchestration remain unimplemented. Future checks should exercise:

- Workflow state, task, usage reservation, audit and outbox commit or roll back together where required.
- Duplicate delivery and concurrent acceptance advance an expected task only once.
- A deliberate original-capture correction or policy change gets a new expected task; ordinary source edits do not replace original-only Moderation evidence.
- Worker roles cannot rewrite task ownership/bindings, grants, evidence or sanctions.
- Privacy invalidation serializes with prepared-input release and prevents new disclosure of queued work.
- Late workers cannot overwrite a newer attempt or recreate deleted facts.
- Crashes around publication and result persistence recover from stored state.
- Pause, resume and stale evidence compete correctly with action dispatch.
- Conflicting staff ban/unban requests serialize on the same target while preserving their separate authority and outcomes.
- Timed-out external effects remain unknown until attributable reconciliation permits progress.
- Provider retries and potentially billed timeouts remain accounted for.
- Discord handlers actually run the feature DTO validation path; queue consumers validate their notification and stored capability schemas. Type annotations alone are not a validation test.
- Forged actor, guild, installation or authority fields in user arguments are rejected and cannot override the separately constructed trusted caller context.
- Well-formed target IDs from another guild still fail service authorization/scope checks. DTO validation never grants access by itself.
- Public response DTO serialization exposes only allowlisted fields and never leaks private entity properties, raw evidence, prompts or ORM internals.
- A queued interaction surviving process restart through its encrypted request continuation, transferred and cleared atomically at reply acceptance, and purged at expiry.
- Reply content, delivery intent and TaskAcceptance commit atomically; Jobs payload cleanup leaves owner content usable.
- Task retries create multiple attempts but one terminal result per task and one accepted/discarded acknowledgment per result.
- Composite scope foreign keys reject cross-installation references; unresolved target gates and guild budget liabilities survive reinstall.
- Current-source invalidation does not accidentally cancel retained original-evidence tasks, while retention and authority revocation still do.
- Local incompatible workers do not globally park work supported by another deployed worker.
- External dispatch entry points reject an active caller transaction; reads, claims, sends and outcome recording use their stated phases.

Do not keep database transactions open while invoking model providers, Discord or independent artifact storage.
