/**
 * Planned component: RecoveryHandlers
 * Kind: Scheduled entry points
 * Owner: Bot application
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Start bounded recovery batches; business owners retain recovery decisions.
 *
 * Planned methods:
 * - recoverTasks: Invoke TaskRecoveryService for expired attempts, missing work signals and stored
 *   results that have not been accepted.
 * - publishOutbox: Invoke OutboxRelay to deliver committed work references.
 * - recoverEffects: Invoke BanService, WarningService and enabled KickService recoverDueActions
 *   plus ReplyDeliveryService.recoverDueDeliveries. Pass bounded criteria; candidate queries and
 *   dispatch/reconciliation decisions stay with owners.
 * - runRetention: Invoke MemoryService.expireFacts when enabled and ArtifactStore deleteExpired.
 *   Additional owner entry points for moderation evidence, community request and debate transcript
 *   retention/removal remain deferred until their retention rules are chosen; this handler must
 *   never delete those records directly.
 *
 * Invariants:
 * Fresh ORM context per batch, bounded work size, and safe concurrent scheduling. Never blindly
 * resend a Discord operation whose outcome remains unknown. No direct queries of another context's
 * entities from these handlers.
 */
