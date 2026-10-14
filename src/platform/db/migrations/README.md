# Migration design placeholder

This directory contains no migrations. The repository is a comment-only design scaffold.

Future migrations will define context-owned tables, Jobs records and Usage records; guild-scoped references; uniqueness and conditional-transition support; immutable task bindings; and restricted bot/worker access. The expected-task acceptance constraint must allow a new task for a repeated workflow stage.

Use separate migration credentials. Review pg-boss installation and migration requirements for the pinned version, and apply its schema changes in a controlled deployment step. Do not grant workers broad prepared-input or business-table access to make startup succeed. Worker input release must use a restricted eligibility gate that serializes with invalidation.

Document compatibility for persisted task schemas, deployment ordering, backup/restore and rollback after new task or policy versions are issued. A migration will need real PostgreSQL verification when implementation begins; no migration or test is implemented here.
