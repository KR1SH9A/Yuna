# Deployment migrations remain pending

Entity mappings and `../schema-constraints.ts` now define a testable PostgreSQL schema. `npm run schema:sql` prints the core schema; `npm run schema:sql -- --include-staged` includes all 40 models. The schema has been designed for explicit migration review, never application-startup synchronization. No deployment migration has been applied.

Use the combined generator: bare MikroORM schema generation omits the additional scalar-ID foreign keys and cross-row guards. Keep these constraints in reviewed migration changes when models change. Database tests apply the combined schema to an isolated temporary PostgreSQL cluster.

Before deploying a service slice, add versioned migrations, restricted bot/worker roles and the selected queue schema. Scope schema deployment to enabled features; optional governance, Memory and Debates remain staged. Runtime workers must not acquire broad prepared-input or business-table access merely to make startup succeed.
