# PostgreSQL and conversation integration checks

`entities.postgres.test.ts` runs under Jest against an isolated temporary PostgreSQL cluster. It verifies the core/full schemas, explicit administrator unban provenance, original evidence after job cleanup, scoped constraints, immutable evidence and competing ORM writes. Run it with `npm run test:db`, or include it with `npm run test:all`; PostgreSQL `initdb`, `pg_ctl` and `psql` must be on PATH. Both commands run the database suite serially with explicit setup/teardown timeouts and real timers.

`runtime-database.postgres.test.ts` uses another private cluster to verify that both process roles connect to the database selected by their URL and release their sessions. It also checks that startup leaves schema/tables untouched and rejects a missing database without creating it. Restricted grants are checked separately by the migration and conversation suites.

`migrations.postgres.test.ts` applies the exact versioned SQL with the real preparation service and verifies role restrictions, idempotence, checksum drift, safe password handling, rollback and unrelated-table protections.

`conversation-jobs.postgres.test.ts` uses the real worker login to exercise competing claims, daily caps, isolated disclosure, invalidation, lost attempts, late usage and payload cleanup. `conversation-flow.postgres.test.ts` runs the owner flow against actual migrated bot/worker roles with fake generation and a mocked Discord boundary: durable success, duplicate intake, edits, unknown sends, expiry, retention, disconnect and restart fencing. No external network calls or user credentials are used.

Broader future checks for moderation, memory, debates and interaction workflows should exercise:

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
