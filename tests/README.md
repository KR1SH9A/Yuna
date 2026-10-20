# Verification

All suites use Jest with explicit imports from `@jest/globals`. Each command first compiles TypeScript, then runs the emitted ESM with the same compiler settings as the application.

| Command | Scope |
| --- | --- |
| `npm test` | Entity, configuration, lifecycle/subprocess, Discord transport, LLM, task-handler and test-environment checks; excludes database integration tests. |
| `npm run test:db` | Real PostgreSQL entity/runtime, migration/role, Jobs and full conversation-flow checks, run serially. |
| `npm run test:all` | All 161 checks across 19 suites, run serially (verified 21 October 2026). |

The database suite starts a private temporary PostgreSQL cluster and checks real schema creation, round-trip persistence, tenant constraints, original evidence retention and competing updates. PostgreSQL `initdb`, `pg_ctl` and `psql` must be on PATH. The suite never uses an existing database and closes its ORM connection and cluster after execution. Database setup and teardown have explicit timeouts for cluster lifecycle operations.

[`config/runtime-config.test.ts`](config/runtime-config.test.ts) checks role-specific settings, independent adapter modes, production restrictions, missing credentials/models, malformed PostgreSQL URLs, bounded integers, frozen snapshots and `.env.example` parsing. Throwing getters verify that unused secrets and other-role settings are never read. Error inspection checks that supplied secrets do not appear in messages, stacks or causes. These tests use isolated environment maps and fixture credentials; they do not mutate `process.env` or call external services.

Runtime tests cover ten lifecycle cases, six bootstrap/composition cases, seven database-resource unit cases and eight real child-process cases. Promise gates verify startup/cleanup ordering, abort races and repeated shutdown without timing guesses. Subprocesses receive actual SIGINT/SIGTERM signals and verify normal exit, listener removal, failed startup, hanging work and cleanup leaks. Database unit tests stub only connection/query/closure boundaries; the temporary environment overrides are restored after each check. Three additional PostgreSQL tests prove selected-database connectivity and released sessions, absence of startup schema changes, and failure without automatic creation of a missing database.

`jest.config.mjs` selects the Node environment and disables Jest transforms because `tsc` already emits JavaScript. Node's `--experimental-vm-modules` flag enables Jest's ESM execution and may print an experimental-feature notice. No extra TypeScript transformer is installed. See [Jest's ESM guidance](https://jestjs.io/docs/ecmascript-modules).

`setup/structured-clone.ts` addresses [Jest's native clone realm mismatch](https://github.com/jestjs/jest/issues/14947). It calls native `structuredClone`, then restores the test realm's prototypes on cloned JSON objects and arrays. This allows successive `copyJson` calls to retain the same plain-object checks used in production. It preserves native errors and transfer behavior; it does not normalize other native types or traverse Map/Set entries. The two setup regression tests cover repeated copying, ownership, aliases, cycles, sparse arrays, negative zero, special property names, invalid JSON, transfers and uncloneable input.

Keep real timers for database work. Existing entity tests pass explicit dates instead of changing the clock; faking `process.nextTick` can disrupt database connection pools. See [MikroORM's Jest guidance](https://mikro-orm.io/docs/usage-with-jest).

Conversation tests include strict mention/reply filtering, permissions and source rechecks, request deadlines, fake/live DeepSeek fixtures, malformed results, aborts, single-attempt execution and uncertain Discord outcomes. Migration tests use actual separate runtime logins to verify permissions, idempotence, checksum rejection and protected unrelated data. Jobs tests cover competing claims, daily limits, disclosure invalidation, immutable results and retention. Full-flow tests exercise real owner transactions from input to fake generation and mocked delivery, duplicate messages, edits, reconnect/restart fencing and cleanup.

External calls are mocked; no Discord token, provider key or existing database is used. Passing these checks does not establish live credentials, model quality, production throughput or moderation readiness. Complete the manual round trip in [the local test guide](../docs/LOCAL_TEST.md). The boundary/scenario plans still describe broader staged features.
