/**
 * Planned component: DiscordHandlers
 * Kind: Inbound event handlers
 * Owner: Bot application
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Normalize Discord input and invoke the owning context through its public API.
 *
 * Planned methods:
 * - onMessageCreated: Accept a Gateway message; normalize trusted source metadata; route eligible
 *   input independently to Moderation and Community.
 * - onMessageUpdated: Accept a source update; route its revision to the owners of affected
 *   evidence and conversation work without inventing missing original content.
 * - onMessageDeleted: Route source IDs and deletion metadata; do not infer who deleted it.
 * - onInteraction: Acknowledge or defer an interaction promptly, validate its input, and route it
 *   to the appropriate feature with authenticated actor context.
 * - onGuildJoined: Notify GuildLifecycleService of a trusted installation event.
 * - onGuildRemoved: Notify GuildLifecycleService to suspend new work and begin cleanup.
 *
 * Collaborators:
 * DiscordInputNormalizer and public context services. No context repositories.
 *
 * Invariants:
 * Create one fresh ORM context for each top-level event. Slow or disabled conversation handling
 * must not suppress moderation intake. This file routes events; feature services own eligibility
 * rules and durable progress.
 */
