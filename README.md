# Yuna

Yuna is a planned Discord assistant for conversation, server help, moderation, administration, personal memory and structured debates.

**Current state: a design scaffold.** Every TypeScript file contains comments describing a planned component and its methods. There are no implemented classes, imports, interfaces, decorators, runtime configuration, dependencies or executable tests. This workspace cannot be built or started yet.

Start with the [architecture plan](docs/ARCHITECTURE_PLAN.md) for proposed ownership, durable intake, task lifecycle, configuration, cleanup and implementation order. Use the [data model reference](docs/DATA_MODEL_REFERENCE.md) to look up every existing entity concept and the proposed additions. Both distinguish the current scaffold from planned changes.

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
| `tests` | Written plans for future boundary, integration and scenario checks. |
| `docs` | Architecture plan, entity lookup, DTO/module reference and future decision records. |

## How to read a placeholder

Each TypeScript file names its planned component, role and owner, then describes its responsibility, methods and boundaries. Entity files also identify important fields. Immutable records and wiring modules explicitly have no business mutation methods.

Services coordinate I/O and workflows. Policies evaluate supplied values. Entities protect their local state transitions. Adapters communicate with external systems. A service does not need to exist for every entity.

Within a feature, `dto/` holds named use-case inputs and serialized outputs; `contracts.ts` holds trusted bindings and shared domain values; `entities/` holds private persistence records. Related DTOs share a use-case file. DTOs describe fields and validation, not database tables or business methods. Feature services use native ORM repositories/query APIs in the caller's transaction; custom repositories are introduced only for concrete queries that warrant them.

Discord handlers fill the transport/controller role. They validate feature arguments and separately supply verified caller identity. Module files name the services other modules may inject; policies, entity registrations and repositories stay private. DTO and schema files are plain imports rather than injectable services.

The scaffold reserves all five business contexts; it does not commit them all to the first release. Optional governance and kick behavior are marked in their files. Memory and Debates are staged features. Add future features through a clear owner, narrow contracts and ordinary application composition; create new files when a concrete feature needs them.

## Working boundaries

- A context owns its entities and uses another context only through its public contract/service boundary.
- Moderation owns the observation-to-assessment workflow. AI handlers execute individual prepared tasks.
- Provider modules do not import contexts, Jobs, Discord or one another.
- Discord handlers live in `apps/bot`; the Discord adapters do not import feature services.
- Task/result binding, durable action intent and uncertainty are explicit. No exactly-once external-effect guarantee is assumed.
- Personal memory, moderation evidence and debate transcripts have separate ownership and retention.

These are intended constraints documented in comments. Automated enforcement will be added with implementation.

## When implementation begins

Choose and pin compatible runtime/package versions, then add the real package manifest, lockfile, TypeScript/NestJS configuration, environment validation and local database setup. Add actual migrations, test tooling and CI alongside the first complete feature slice.

No empty `package.json`, pretend build scripts, runnable queue workers or placeholder credentials have been added. Existing design documents and reference media remain in their current locations.
