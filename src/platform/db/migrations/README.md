# Explicit database preparation

`npm run db:prepare` builds and runs `apps/admin/cli.ts` with `.env.admin`. The existing database must be owned by the supplied administrator, which needs permission to create login roles. See [local setup](../../../../docs/LOCAL_TEST.md).

`prepareDatabase` holds a transaction-scoped advisory lock, validates the applied migration prefix/checksums, applies missing SQL and records it in `yuna_schema_migrations`. Role/password changes and grants share the transaction. Re-running preserves rows, verifies migration identity and restores the reviewed grants; checksum drift aborts. Never edit an already deployed migration—add a new version instead.

1. `001-core.sql` snapshots the combined core entity schema plus scoped foreign keys and cross-row guards. It includes future core storage without enabling those features.
2. `conversation-worker.sql` adds the restricted claim/release/start/finish/recover operations. The deferred execution-consistency trigger runs with trusted-owner privileges and a fixed search path so restricted worker commits can enforce it without table privileges.

`yuna_bot` receives CRUD on the enabled conversation/platform tables. `yuna_worker` receives only the designated worker-function EXECUTE grants and schema usage. Runtime roles must not own database objects, have elevated flags or role memberships. PUBLIC schema creation and direct execution of internal helpers/guards are revoked. Unrelated inherited table/column grants cause setup to fail rather than silently alter unrelated objects.

Runtime bot/worker startup never executes DDL. The worker discovers no business entity metadata. SQL functions use a fixed trusted search path and recheck task/source/safety authority before disclosure and dispatch.

Use `npm run schema:sql` for model/schema review; it includes the additional constraints that bare ORM schema generation would omit. The optional staged schema remains a separate future deployment decision. Migration and worker tests use temporary private PostgreSQL clusters and actual restricted login roles.
