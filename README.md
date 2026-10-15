# Yuna

Yuna is a planned Discord assistant for conversation, server help, moderation, administration, personal memory and structured debates.

**Current state: implemented entity layer.** All 40 planned records have typed MikroORM mappings, constructors, local transition guards and concise ownership comments. The repository builds and has executable entity and PostgreSQL persistence tests. Application services, DTOs, handlers and runtime composition remain design scaffolds; the Discord bot cannot be started yet.

Start with the [architecture plan](docs/ARCHITECTURE_PLAN.md) for proposed ownership, durable intake, task lifecycle, configuration, cleanup and implementation order. Use the [entity model plan](docs/DATA_MODEL_REFERENCE.md) for target fields, constraints, ownership, lifecycle and verified Discord API implications across all 40 planned records. It includes original-only moderation, durable accepted reply content and immutable installation identities. The entity layer implements storage and local invariants; orchestration, permission checks and external effects remain service work.

The [DTO and module reference](docs/DTO_REFERENCE.md) maps request/response DTOs to their owning services, explains trusted caller context, and lists each module's public providers. The scaffold now gives concrete DTOs their own files under the relevant feature's `dto/` directory.

## Layout

| Directory | Purpose |
| --- | --- |
| `apps/bot` | Discord-facing runtime composition, inbound handlers, completion routing and recovery entry points. |
| `apps/ai-worker` | Restricted worker composition, explicit task registration and individual AI task handlers. |
| `src/contexts/community` | Conversation requests, approved knowledge, reply policy and delivery. |
| `src/contexts/moderation` | Cases, evidence, findings, warnings, sanctions and authenticated staff actions. |
| `src/contexts/administration` | Guild lifecycle, grants, safety state, usage policy and optional approvals. |
| `src/contexts/memory` | Personal consent, facts, permitted retrieval and deletion. |
| `src/contexts/debates` | Participation, transcripts, rubric evaluation and publication. |
| `src/ai` | Plain capability contracts and separate LLM/Jev/embedding integrations. |
| `src/discord` | Normalized event/context DTOs, reads and effects, independent of business contexts. |
| `src/platform` | Database boundaries, durable jobs, usage accounting, artifacts and audit. |
| `tests` | Executable entity/PostgreSQL tests and plans for future application checks. |
| `docs` | Architecture plan, entity lookup, DTO/module reference and future decision records. |

## Entities and remaining scaffolds

Entity files contain real classes and mappings. Their methods use supplied values only; callers must perform authorization, locking and related writes in one transaction. Comments explain decisions such as immutable original evidence, uncertain effects and payload retention. Other TypeScript files still describe their planned components and methods.

Services coordinate I/O and workflows. Policies evaluate supplied values. Entities protect their local state transitions. Adapters communicate with external systems. A service does not need to exist for every entity.

Within a feature, `dto/` holds named use-case inputs and serialized outputs; `contracts.ts` holds trusted bindings and shared domain values; `entities/` holds private persistence records. Related DTOs share a use-case file. DTOs describe fields and validation, not database tables or business methods. Feature services use native ORM repositories/query APIs in the caller's transaction; custom repositories are introduced only for concrete queries that warrant them.

Discord handlers fill the transport/controller role. They validate feature arguments and separately supply verified caller identity. Module files name the services other modules may inject; policies, entity registrations and repositories stay private. DTO and schema files are plain imports rather than injectable services.

The scaffold reserves all five business contexts; it does not commit them all to the first release. Optional governance and kick behavior are marked in their files. Memory and Debates are staged features. Add future features through a clear owner, narrow contracts and ordinary application composition; create new files when a concrete feature needs them.

## Working boundaries

- A context owns its entities and accepted business output, and uses another context only through its public contract/service boundary.
- Moderation owns the original-capture-to-observation-to-assessment workflow. Edits/deletion never replace the original evidence; an uncaptured original remains missing. AI handlers execute individual prepared tasks.
- Provider modules do not import contexts, Jobs, Discord or one another.
- Discord handlers live in `apps/bot`; the Discord adapters do not import feature services.
- Task/result binding, durable action intent and uncertainty are explicit. No exactly-once external-effect guarantee is assumed.
- Personal memory, moderation evidence and debate transcripts have separate ownership and retention.

Entity tests and PostgreSQL constraints enforce the implemented storage rules. Application boundaries and runtime transaction/permission checks still need implementation.

## Build and verify

Use Node.js 24 or newer. Dependencies and their lockfile are pinned.

```sh
npm ci
npm run typecheck
npm test
npm run test:db
```

The database tests require PostgreSQL `initdb`, `pg_ctl` and `psql` on PATH. They create a private temporary cluster using a Unix socket, run the complete schema and persistence checks, then stop and remove that cluster. They do not connect to an existing database or Discord.

`npm run schema:sql` prints the core schema for review; append `-- --include-staged` to include optional governance, Memory and Debates. The generator combines entity mappings with scoped foreign keys and cross-row guards. Using MikroORM's schema generator alone omits those extra guards. No application startup synchronizes a schema, and no migration has been deployed.

## Implementation boundaries

- Automatic policy bans need supported original-evidence findings and no staff review.
- Unbans require an explicit request through Yuna from a current Discord administrator. The entity requires the exact internal request/authority record; services must still obtain and recheck live permissions.
- Original evidence, accepted reasons and action intent commit before dispatch. Intake/Jobs payload cleanup does not remove Moderation's retained copy.
- Default schema registration includes 27 core entities. Thirteen staged entities are opt-in; their classes do not enable those features.
- Database revisions detect competing ORM updates. They do not replace the source/target locks and transaction boundaries specified in the architecture.

Next implementation work is service transactions, live authorization and Discord/provider adapters, followed by reviewed deployment migrations and role grants. This change does not implement those workflows.
