# Planned boundary checks

No tests are implemented yet. Future checks should verify:

- Only composition roots and inbound handlers wire feature public APIs to infrastructure.
- Context-private entities and repositories do not cross context boundaries.
- Jev and LLM do not import each other, business contexts, Jobs or Discord.
- Worker application code cannot import privileged feature repositories or Discord adapters.
- Discord adapters and generic job transport do not depend on business contexts.
- Policy and entity transition methods do not perform external I/O.
- Direct and transitive imports contain no dependency cycles or accidental entity/provider exports.

Boundary rules belong in automated tooling once real imports exist. Comment-only files do not demonstrate that the runtime boundaries are enforced.
