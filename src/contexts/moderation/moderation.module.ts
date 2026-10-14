/**
 * Planned component: ModerationModule
 * Kind: NestJS composition module
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Register ModerationService, ModerationPolicy, StaffModerationService, BanService and WarningService
 * with the seven private moderation records. Register KickService only if explicit kicks ship.
 * Export the public intake/staff services; wire effect services
 * directly into bot dispatch/recovery handlers.
 *
 * Scope:
 * Automatic moderation follows the selected PDF policy once validated; explicit kicks are
 * scope-dependent. No recurring strike ladder is implied.
 *
 * Planned methods:
 * No business methods planned. This file will describe dependency registration, private entity
 * registration and the narrow exported public services.
 *
 * Collaborators/Boundaries:
 * Consume Administration authority/safety APIs, Jobs, Usage, ArtifactStore, Audit and Discord
 * read/action contracts. Do not import personal Memory or AI provider implementations.
 *
 * Invariants:
 * Composition must not contain business decisions or conceal dependency cycles with forward
 * references.
 */
