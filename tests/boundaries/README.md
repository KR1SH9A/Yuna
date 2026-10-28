# Executable import boundaries

`imports.test.ts` parses TypeScript imports/exports and checks all source modules in `src` and `apps`:

- LLM/Jev/embedding adapters cannot import one another, business contexts, Jobs, Discord or application composition.
- Worker composition cannot import Discord or business contexts.
- Discord cannot import feature contexts or applications.
- Feature contexts cannot import application composition.
- Local imports must resolve, and runtime imports must contain no cycles (type-only imports are excluded from cycle analysis).

These checks cover the stated executable boundaries. They do not prove that every DTO is safe, that all cross-context entity access is absent, or that every task kind has a handler and owner acceptor; those need targeted workflow tests as each route is enabled.
