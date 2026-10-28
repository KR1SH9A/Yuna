/**
 * Planned component: JobsModule
 * Kind: NestJS infrastructure composition module
 * Owner: Platform / Jobs
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: Bot and worker composition roots directly construct their permitted task services/stores. Current operation uses no NestJS module or external queue.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility:
 * Wire durable task records, restricted worker access, recovery and outbox delivery.
 *
 * Planned methods:
 * None. Future wiring registers TaskService, WorkerTaskStore, TaskRecoveryService, OutboxRelay and
 * the Jobs-owned entities. Bot and worker roots select their permitted providers and database
 * credentials; the module does not choose business handlers.
 *
 * Public provider surfaces:
 * Bot composition receives TaskService, TaskRecoveryService and OutboxRelay. Worker composition
 * receives the restricted WorkerTaskStore surface with restricted credentials; it cannot resolve
 * the privileged bot mutation API merely because both roles use this module's source directory.
 * Records and ORM repositories stay private. DTOs/contracts are plain imports, not providers.
 *
 * Boundaries/invariants:
 * No business-context entities, Discord operations or provider SDKs are imported here. Task
 * signals carry IDs; task identity and routing come from persisted metadata. The outbox remains
 * the baseline until shared-transaction enqueue is demonstrated. At-least-once delivery requires
 * conditional claims and atomic result acceptance; queue acknowledgments do not establish
 * exactly-once external effects.
 */
