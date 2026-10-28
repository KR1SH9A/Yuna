# Work on Yuna

Begin with [Yuna.md](Yuna.md), the file's purpose comment and the nearest test. The architecture and data-model references describe both implemented boundaries and deliberately staged extensions; a class appearing in a reference does not by itself make its feature active.

## Make one reviewable change

Keep a change focused on one owner and one behavior. Reuse an existing public service method when it already performs the job. Add a new function when the behavior genuinely has no owner, then document why it exists, what it accepts, what it returns and which transaction or external boundary it uses. Avoid adding wrappers that only rename an existing call.

Preserve unrelated local changes. Do not change an applied migration's text: its checksum is part of deployment history. Create an additive migration and update the explicit runner, grants and upgrade tests together. Runtime roles do not own schema or run DDL.

## Read and document the flow

- Put a short purpose comment above each source file's imports. A newcomer should know which part of Yuna it serves.
- Explain each named function or method in plain language. Mention the non-obvious contract: required locks, exact revision, immutable snapshot, permitted audience, idempotency or cleanup obligation.
- Add inline comments where order matters, especially before disclosure, external I/O, acknowledgment and deletion. Explain the reason instead of translating every line into English.
- Keep comments accurate when behavior changes. `npm run check:docs` detects missing comments; it cannot judge their truth.
- Update `Yuna.md` with the public function, data flow and reason for the change. JSON settings belong in the configuration guide; do not insert invalid comments into standard JSON.

## Respect ownership

Feature services own their records and meaning. Composition roots may connect services; transports and provider adapters receive narrow plain values. Discord adapters must not import feature services. Provider modules must not retrieve business records or call each other. Workers access only their restricted SQL entry points and never receive the Discord token.

A successful model response is not an authorized action. Persist results, then let the owner validate the exact task, generation, source/evidence, policy, consent, audience and expiry. Commit accepted owner output and acknowledgment together. Commit an exact effect intent before I/O, and record the observed outcome separately. Preserve unknown outcomes instead of turning them into retries or refunds.

If a setting changes, decide explicitly whether earlier work drains or is invalidated. A privacy withdrawal must block new disclosure immediately; physical cleanup can follow in bounded transactions. Retention and removal need a named owner, a bounded operation and a truthful completion/retention disposition.

## Verify the behavior

Run `npm test` for changes that do not need a database, and `npm run test:db` for persistence, permissions or concurrency changes. Use `npm run test:all` before finishing an integrated change, plus `npm run check:docs` and `git diff --check`. `npm run test:coverage` identifies unexercised code; coverage alone does not establish correctness.

Concurrency tests should control ordering with promise checkpoints and observe actual PostgreSQL lock waits. Avoid sleeps that merely hope a race happened. Test rollback at the boundary where output and acknowledgment must commit together. A fake provider or Discord transport must never conceal that an uncertain operation may have incurred cost or completed remotely.

The database helper creates private temporary clusters and uses distinct runtime roles. Never point integration tests at a real application database. Operational tests rehearse dump/restore and bounded fake load; they do not deploy the project. Consult current primary documentation before changing a provider, Discord, Node or PostgreSQL contract, and record useful references beside the change.
