/**
 * Planned component: ModerationModule
 * Kind: NestJS composition module
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Register ModerationService, ModerationPolicy, StaffModerationService, BanService
 * and WarningService with the seven private moderation records. Register KickService only if
 * explicit kicks ship. Explicit public service exports: ModerationService, StaffModerationService,
 * BanService and WarningService; export KickService only when explicit kick is enabled. Bot
 * dispatch/recovery handlers inject those exported effect services. Keep ModerationPolicy, all
 * seven entities and native repository providers private.
 *
 * Scope: Automatic moderation follows the selected PDF policy once validated; explicit kicks are
 * scope-dependent. No recurring strike ladder is implied.
 *
 * Planned methods: No business methods planned. This file will describe dependency registration,
 * private entity registration and the narrow exported public services.
 *
 * Collaborators/Boundaries: Consume Administration authority/safety APIs, Jobs, Usage,
 * ArtifactStore, Audit and Discord read/action contracts. Do not import personal Memory or AI
 * provider implementations.
 *
 * Persistence and DTO wiring: Register owned entities with native MikroORM repository providers in
 * this module; owning services use those providers directly. No custom repository or generic CRUD
 * wrapper is introduced. DTO catalogues are plain boundary descriptions, not DI service providers.
 * Exported services return DTO/plain binding values rather than entities.
 *
 * Invariants: Composition must not contain business decisions or conceal dependency cycles with
 * forward references.
 */
