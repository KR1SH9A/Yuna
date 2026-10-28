# Operate a Yuna installation

Use the [local setup guide](LOCAL_TEST.md) for credentials and initial database preparation, then choose a [policy template](../config/README.md). Build and run the tests before replacing a running deployment. The repository's supervisor examples are templates; no service is installed or started by building the project.

## Start, stop and inspect

Run the bot and worker as separate processes. The bot receives the Discord token; only the worker receives provider keys. `npm run db:prepare` is the explicit administrator-only migration step. Runtime processes never run DDL. `npm run register:commands` registers only Yuna's guild command and requires the application ID; registration does not start the bot or change policy.

For a supervised installation, fill the absolute project and Node executable paths in `deploy/launchd/*.plist.example` on macOS or `deploy/systemd/*.service.example` on Linux. Use an ordinary account with access only to the deployment and its local credentials. Create `.local/logs` before using the launchd examples. Keep process logs bounded with the supplied logrotate example or your system journal's size/retention settings; the templates do not install log rotation. Do not enable both supervisors for the same deployment.

Stop with SIGTERM or Ctrl+C. Yuna closes ingress, cancels loops, drains in-flight callbacks and closes database sessions. Its shutdown deadline is ten seconds; the examples allow fifteen seconds before the supervisor forces termination. A failed process restarts with a delay. A PostgreSQL advisory session lock prevents two bot processes from owning one guild. Losing that session stops ordinary admission; the next process performs normal recovery before acting.

`npm run health` prints a small JSON snapshot using only the bot database URL and guild ID. Exit zero means the latest installation is active, unpaused, marked available and has a live bot ownership lock. Exit one means it is not ready or the probe failed. It does not prove that a provider is reachable or that an idle worker process is alive. Check the supervisor's worker state and whether task backlog makes progress over repeated observations.

Use `/yuna status` for authorized installation revisions, grants and conversation backlog, `/yuna action` for an authorized action's outcome, and `/yuna usage` for your own quota and spending. Health output includes queued/running/overdue tasks, unknown sends/actions and unresolved charges without source text or credentials.

## Failure recovery

| Symptom | Meaning and next step |
| --- | --- |
| Database unavailable | Owner callbacks fence availability; background operations back off. Restore connectivity and allow recovery. A lost ownership session requires a fresh process. |
| Ready tasks do not progress | Check worker process, provider mode, selected model names, migration grants, price snapshots and remaining allowances. |
| Unknown provider cost | The request may have been charged. Its reservation remains; a timeout is not a refund. |
| Unknown Discord effect | Inspect the action or reply outcome. Reconciliation needs exact attributable remote evidence. Never resend or reverse merely because the lease expired. |
| Policy file differs from approved policy | Apply `/yuna configure` as an authorized operator. Existing revisions and new policy changes are handled transactionally. |
| Source edited/deleted or gateway gap occurred | Pending conversation work is invalidated. A new user request can begin fresh work. Moderation continues only from its retained original evidence. |
| Cleanup reports retained data | Read the owner's explicit disposition. Unresolved charges/effects and audit records inside their retention period are not represented as fully erased. |

The startup and maintenance logs use fixed classifications. Timing samples contain bounded task/request IDs and durations; they omit message content, credentials and provider bodies. Do not replace safe errors with raw driver dumps in production logs.

## Backup and restore

Use PostgreSQL's `pg_dump --format=custom` with a database administrator or a dedicated backup account, keeping credentials in `.pgpass` or your secret manager rather than shell arguments. Store dumps outside the repository and restrict file permissions: backups contain retained user data. Apply the same privacy and expiry policy to backup copies.

1. Pause admission or stop the bot and worker for a quiet recovery point. Record the application revision and migration ledger alongside the dump. PostgreSQL provides a consistent snapshot, but a snapshot cannot recall external calls that were in flight.
2. Restore into a **new isolated database** with `pg_restore --single-transaction --no-owner`, preserving the dumped ACLs. The `yuna_bot` and `yuna_worker` roles must already exist on the target cluster. On a new cluster, create each as an unprivileged `NOLOGIN NOINHERIT` role before restoring; do not give it ownership or elevated flags. Then run `db:prepare` against the restored database to set runtime login/passwords and verify migration checksums and exact privileges. Do not use `--no-privileges`: default public function execution would violate Yuna's restricted worker boundary, and preparation correctly rejects that drift.
3. Keep external integrations disabled during inspection. Verify installation generations, current policy, unresolved reservations, and ambiguous action/reply records. Do not reset attempt counts or mark uncertain operations as unused.
4. Start one bot and its worker against the restored database only when the old deployment is stopped. Recovery expires stale work and reconciles attributable outcomes; it does not replay a disclosed provider attempt or an unknown Discord effect.

The `operations.postgres.test.ts` rehearsal performs an actual dump and restore of a private test database, checks migration history, and proves that a disclosed attempt remains charged/uncertain without a second provider call. This is a repeatable automated rehearsal, not evidence that any production database has been backed up.

## Bounded load rehearsal

The same integration suite admits thirty concurrent fake inputs with a twenty-pending-request limit, drains the twenty admitted tasks through four worker lanes, and asserts twenty unique replies. It records elapsed time and end-to-end p95 for that run. It is a bounded functional load exercise; real provider latency, Discord rate limits and sustained throughput need deployment-specific measurements before increasing concurrency.

The worker shares its configured lane count across conversation, moderation and Debate routes. Notifications only shorten polling waits; they carry no authority or content. PostgreSQL claims, provider-start records, owner acceptance and external-effect claims remain authoritative when notifications are missed.

Implementation references: [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html), [advisory locks in pg_locks](https://www.postgresql.org/docs/current/view-pg-locks.html), [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html), and [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html).
