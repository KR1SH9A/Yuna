# Verification

All suites use Jest with explicit imports from `@jest/globals`. Each command first compiles TypeScript, then runs the emitted ESM with the same compiler settings as the application.

| Command | Scope |
| --- | --- |
| `npm test` | Entity, configuration, lifecycle/subprocess, Discord transport, LLM, task-handler and test-environment checks; excludes database integration tests. |
| `npm run test:db` | Real PostgreSQL entity/runtime, migration/role, Jobs and full conversation-flow checks, run serially. |
| `npm run test:all` | All current suites, including real PostgreSQL concurrency, permissions, privacy, quota and operational checks, run serially. See Yuna.md for the latest verified totals. |

The database suite starts a private temporary PostgreSQL cluster and checks real schema creation, round-trip persistence, tenant constraints, original evidence retention and competing updates. PostgreSQL `initdb`, `pg_ctl` and `psql` must be on PATH. The suite never uses an existing database and closes its ORM connection and cluster after execution. Database setup and teardown have explicit timeouts for cluster lifecycle operations.

[`config/runtime-config.test.ts`](config/runtime-config.test.ts) checks role-specific settings, independent adapter modes, production restrictions, missing credentials/models, malformed PostgreSQL URLs, bounded integers, frozen snapshots and `.env.example` parsing. Throwing getters verify that unused secrets and other-role settings are never read. Error inspection checks that supplied secrets do not appear in messages, stacks or causes. These tests use isolated environment maps and fixture credentials; they do not mutate `process.env` or call external services.

Runtime tests cover lifecycle, bootstrap/composition, database resources, exclusive bot ownership and real child-process failures. Promise gates verify startup/cleanup ordering, abort races and repeated shutdown without timing guesses. Subprocesses receive actual SIGINT/SIGTERM signals and verify normal exit, listener removal, failed startup, hanging work and cleanup leaks. Database unit tests stub only connection/query/closure boundaries; the temporary environment overrides are restored after each check. PostgreSQL checks prove selected-database connectivity and released sessions, absence of startup schema changes, and failure without automatic creation of a missing database.

`jest.config.mjs` selects the Node environment and disables Jest transforms because `tsc` already emits JavaScript. Node's `--experimental-vm-modules` flag enables Jest's ESM execution and may print an experimental-feature notice. No extra TypeScript transformer is installed. See [Jest's ESM guidance](https://jestjs.io/docs/ecmascript-modules).

`setup/structured-clone.ts` addresses [Jest's native clone realm mismatch](https://github.com/jestjs/jest/issues/14947). It calls native `structuredClone`, then restores the test realm's prototypes on cloned JSON objects and arrays. This allows successive `copyJson` calls to retain the same plain-object checks used in production. It preserves native errors and transfer behavior; it does not normalize other native types or traverse Map/Set entries. The two setup regression tests cover repeated copying, ownership, aliases, cycles, sparse arrays, negative zero, special property names, invalid JSON, transfers and uncloneable input.

Keep real timers for database work. Existing entity tests pass explicit dates instead of changing the clock; faking `process.nextTick` can disrupt database connection pools. See [MikroORM's Jest guidance](https://mikro-orm.io/docs/usage-with-jest).

Conversation tests include strict mention/reply filtering, permissions and source rechecks, request deadlines, fake/live DeepSeek fixtures, malformed results, aborts, single-attempt execution and uncertain Discord outcomes. Migration tests use actual separate runtime logins to verify permissions, idempotence, checksum rejection and protected unrelated data. Jobs tests cover competing claims, daily limits, disclosure invalidation, immutable results and retention. Full-flow tests exercise real owner transactions from input to fake generation and mocked delivery, duplicate messages, edits, reconnect/restart fencing and cleanup.

Notification coverage includes the scan/wait race, one hint waking multiple lanes, missed hints, listener reconnect, bounded startup, late connection cleanup and cancellation. PostgreSQL tests check migration upgrades, commit-only empty payloads, rollback and restricted worker result insertion. The notification-flow integration test starts two idle consumers with a one-minute fallback, admits two requests, holds both fake providers concurrently, then completes both replies before that fallback can fire. Timing tests check allowlisted logs, post-commit emission and logger-error isolation. Maintenance tests verify independent loops and active-send reconciliation protection.

External calls are mocked; no Discord token, provider key or existing database is used. Passing these checks does not establish live credentials, model quality, production throughput or moderation readiness. Complete the manual round trip in [the local test guide](../docs/LOCAL_TEST.md). The boundary suite enforces imports and runtime dependency cycles. Staged optional features are identified separately in Yuna.md.

The newer feature suites exercise these boundaries:

| Suites | Evidence |
| --- | --- |
| `administration-*`, `removal` | Owner bootstrap, scoped current grants, policy/safety revisions, audit rollback, interrupted cleanup and reinstall. |
| `user-usage` | Concurrent personal attempt/money limits, privacy, lower-only preferences, exact decimal accounting and incompatible currencies. |
| `moderation-*` | Authentic original capture, default policy/exclusions, two-stage assessment, exact contributing findings, single-attempt effects and target uncertainty. |
| `knowledge` | Authorization, visibility, bounded retrieval and revocation/expiry before disclosure or sending. |
| `memory` | Explicit private consent/facts, cross-user rejection, withdrawal/forget races and deletion. |
| `debates` | Exact consented scope, explicit transcript, typed/paired scoring, rollback, payer quota, publication races and cleanup. |
| `operations` | Content-free health, isolated real dump/restore and a finite fake-provider load exercise. |
| `governance`, `governance.dto` | Opt-in staged-schema proposals, exact hashes, distinct current approvers, independent candidate consent and atomic consumption/owner rollback. |
| `artifacts` | Bounded verified bytes, current owner/release bindings, revocation during I/O, deadlines, late uploads and retryable deletion. |
| `embedding.service` | Exact text/model/vector correspondence, bounded responses, fake mode, cancellation and honest unknown usage without live provider calls. |

Moderation action/transport coverage also includes explicit kicks, membership/hierarchy checks, single-attempt uncertainty, exact audit reconciliation and read-only status after departure. These component checks do not register commands or activate staged optional features. Run PostgreSQL suites serially with permission for local shared-memory creation/cleanup; sandbox-denied `initdb` can leave abandoned system allocations even when its temporary directory is removed.

`npm run check:docs` checks purpose comments on TypeScript files and named implementations. `npm run test:coverage` emits V8 statement/branch/function reports plus LCOV. Database suites run serially because each owns a private PostgreSQL cluster.
