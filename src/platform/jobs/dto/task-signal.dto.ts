/**
 * Planned component: TaskSignalDto
 * Kind: Versioned queue notification DTO
 * Owner: Platform / Jobs
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: Current notifications carry empty wake-up hints. Scoped result references come from the route-specific task contracts and durable database scans.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility:
 * Wake an execution or completion consumer with a stored task identity.
 *
 * Planned fields:
 * taskId; notification schemaVersion; optional publication messageId for diagnostics/deduplication.
 * The registered queue/topic determines which known entry point receives the notification.
 *
 * Producer and consumers:
 * OutboxRelay -> AI task handlers for execution, or CompletionHandlers for owner acceptance.
 * TaskRecoveryService republishes references through the same envelope.
 *
 * Validation:
 * Validate IDs, supported notification version and bounded payload at the consumer. Load the
 * task's actual installationId/guildId, owner, kind/version and deadline through TaskService.readTaskDescriptor
 * (bot) or WorkerTaskStore.readTaskDescriptor (worker) before routing. Validate
 * stored capability input/output with its separate AI schema at the applicable boundary.
 *
 * Planned methods:
 * None. No inference result or business operation is embedded in this wake-up DTO.
 *
 * Invariants:
 * Do not trust queue-supplied service names, authority, destination or result payloads. A valid
 * signal does not grant a claim or permission to release content. Duplicate signals are expected.
 */
