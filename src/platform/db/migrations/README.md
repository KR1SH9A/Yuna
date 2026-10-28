# Explicit database preparation

`npm run db:prepare` builds and runs `apps/admin/cli.ts` with `.env.admin`. The existing database must be owned by the supplied administrator, which needs permission to create login roles. See [local setup](../../../../docs/LOCAL_TEST.md).

`prepareDatabase` holds a transaction-scoped advisory lock, validates the applied migration prefix/checksums, applies missing SQL and records it in `yuna_schema_migrations`. Role/password changes and grants share the transaction. Re-running preserves rows, verifies migration identity and restores the reviewed grants; checksum drift aborts. Never edit an already deployed migration—add a new version instead.

1. `001-core.sql` snapshots the combined core entity schema plus scoped foreign keys and cross-row guards. It includes future core storage without enabling those features.
2. `conversation-worker.sql` adds the restricted claim/release/start/finish/recover operations. The deferred execution-consistency trigger runs with trusted-owner privileges and a fixed search path so restricted worker commits can enforce it without table privileges.
3. `003-conversation-notifications.sql` adds task/result insert triggers that notify `yuna_tasks_ready` and `yuna_results_ready` only on transaction commit. Both payloads are empty; notifications carry no content, identifiers or authority. Restricted roles cannot execute the trigger helpers directly. Notifications can be missed or coalesced, so durable scans remain authoritative.

`yuna_bot` receives CRUD only on the explicitly enabled feature/platform tables. `yuna_worker` receives only the designated worker-function EXECUTE grants and schema usage. Runtime roles must not own database objects, have elevated flags or role memberships. PUBLIC schema creation and direct execution of internal helpers/guards are revoked. Unrelated inherited table/column grants cause setup to fail rather than silently alter unrelated objects.

Runtime bot/worker startup never executes DDL. The worker discovers no business entity metadata. SQL functions use a fixed trusted search path and recheck task/source/safety authority before disclosure and dispatch.

Use `npm run schema:sql` for model/schema review; it includes the additional constraints that bare ORM schema generation would omit. The optional staged schema remains a separate future deployment decision. Migration and worker tests use temporary private PostgreSQL clusters and actual restricted login roles.

4. `004-operating-controls.sql` adds approved operator-policy/revision fields and replaces the existing restricted conversation gate/claim/accounting functions. It permits draining admitted Community work, reserves exact monetary estimates from versioned policy snapshots and settles measured usage without refunding unknown spend. The migration runner grants the bot the implemented Administration/audit/moderation tables; worker access remains the same narrow function allowlist. Earlier migration files and their checksums are unchanged.

5. `005-moderation-worker.sql` adds evidence- and policy-bound observation/assessment worker entry points. Exact reported assessment costs settle independently of semantic acceptance.
6. `006-user-quotas.sql` stores private member preferences and enforces member attempt/money caps inside the existing guild/day claim locks. Requester identity comes from trusted owner provenance.
7. `007-knowledge-context.sql` checks approved knowledge revision, hash, visibility and expiry at provider disclosure/start, in addition to the owner acceptance/delivery checks.
8. `008-memory.sql` activates explicit private Memory consent/facts/deletion receipts. It does not enable inferred memories, embeddings or public context copies.
9. `009-debates.sql` activates consented Debate storage and restricted assessment routes, frozen transcript/rubric bindings, exact accounting and revocation-aware recovery.
10. `010-chat-context.sql` checks every selected current chat message at conversation claim/disclosure/start and keeps same-channel scope distinct from original moderation evidence. It upgrades only the old default context-message limit from one to eight, advancing the channel revision; custom limits remain intact.

The new migrations in this change set have not been deployed by this task. The previously present migrations 1–3 retain their original contents. The schema printer remains an entity review tool; the deployment runner also owns platform-only tables such as personal usage preferences.
