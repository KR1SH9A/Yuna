/**
 * Planned component: Transaction and ORM-context plan
 * Kind: Local persistence boundary design
 * Owner: Platform / Database
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: Owners already use orm.em.fork().transactional and join supplied EntityManagers. This note does not require another transaction wrapper.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility:
 * Define how entry points isolate ORM state and owner services share local atomic work.
 *
 * Planned methods:
 * - runWithFreshContext: top-level entry operation -> operation result. Establish a fresh ORM
 *   context for each Gateway event, worker job, completion handler or bounded recovery batch. The
 *   eventual implementation may use native ORM helpers directly.
 * - runInTransaction: local operation and existing transaction context if present -> committed
 *   result or rollback. Join the caller's transaction when present; nested owner-service
 *   operations must not independently commit or use unrelated managers.
 *
 * Boundaries/invariants:
 * These names describe the intended boundary, not a new transaction framework. Keep
 * policy/evidence changes, expected-task acceptance, usage reservations and outbox/audit writes
 * atomic when their workflow requires it. Document a consistent lock order for shared safety,
 * privacy/eligibility, target, case and task/usage rows before implementation; apply it to
 * competing operations. Do not hold a transaction during provider, Discord or independent artifact
 * I/O. Fresh ORM context is not a remote transaction or an exactly-once effect guarantee.
 */
