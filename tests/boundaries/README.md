# Planned boundary checks

No tests are implemented yet. Future checks should verify:

- Only composition roots and inbound handlers wire feature public APIs to infrastructure.
- Context-private entities and repositories do not cross context boundaries.
- Jev and LLM do not import each other, business contexts, Jobs or Discord.
- Worker application code cannot import privileged feature repositories or Discord adapters.
- Discord adapters and generic job transport do not depend on business contexts.
- Policy and entity transition methods do not perform external I/O.
- Direct and transitive imports contain no dependency cycles or accidental entity/provider exports.
- Feature request/response DTOs live with their owner; handlers consume them without feature services importing `apps/bot` or a transport-owned command layer.
- DTOs and public contracts contain no live ORM entities, lazy relations, SDK instances or provider clients. AI capability schemas remain separate from feature request DTOs.
- Bot handlers inject only the providers explicitly exported by feature modules; they cannot bypass ownership by re-registering private services or repositories.
- Policies, entity registrations and native ORM repositories remain private. DTO/type declarations are not registered as injectable providers.
- Static task registration remains a lookup, with no injectable registry or dynamic method discovery requirement.

Boundary rules belong in automated tooling once real imports exist. Comment-only files do not demonstrate that the runtime boundaries are enforced.
