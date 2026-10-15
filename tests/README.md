# Verification

`npm test` compiles the repository and runs focused entity behavior tests using Node's test runner. `npm run test:db` starts a private temporary PostgreSQL cluster and checks real schema creation, round-trip persistence, tenant constraints, original evidence retention and competing updates. PostgreSQL `initdb`, `pg_ctl` and `psql` must be on PATH. The test never uses an existing database.

These tests verify the entity layer. Services, queue workers, provider calls and Discord effects remain unimplemented. The boundary and scenario documents describe that future verification; passing entity tests does not claim a working bot.
