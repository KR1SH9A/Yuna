/**
 * Planned component: OutboxRelay
 * Kind: Transactional Outbox publisher
 * Owner: Platform / Jobs
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: Committed PostgreSQL notification triggers plus task-wakeup.ts and fallback scans provide the current delivery path. A separate external-queue relay is optional.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility:
 * Publish committed work/completion/invalidation signals to the configured delivery path while
 * retaining recoverable publication state.
 *
 * Planned methods:
 * - publishPending: bounded due outbox selection -> publication outcomes. Claim a batch briefly,
 *   publish stored references, and retain failed items for bounded retry.
 * - recordPublished: outbox identity and matching publication attempt -> recorded success or stale
 *   acknowledgment. Use a short conditional database write.
 *
 * Boundaries/invariants:
 * Business/task mutations and their outbox rows commit together before publication. A crash after
 * publishing and before acknowledgment may publish the signal again; consumers deduplicate and
 * recheck durable state. No exactly-once delivery claim. Do not hold a database transaction while
 * performing independent transport I/O. Payloads contain references and versioned metadata, not
 * media blobs or executable service names. The relay does not route into business services or call
 * providers.
 */
