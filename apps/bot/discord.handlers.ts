/**
 * Planned component: DiscordHandlers
 * Kind: Inbound event handlers
 * Owner: Bot application
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Act as the Discord transport/controller boundary: normalize events, validate operation DTOs,
 * supply authenticated context and invoke the owning context through its public API.
 *
 * Planned methods:
 * - onMessageCreated: Accept a Gateway message -> NormalizedDiscordMessageDto; record the durable
 *   intake snapshot and intended deliveries before routing to Moderation and Community. Intake is
 *   the proposed boundary in docs/ARCHITECTURE_PLAN.md, not implemented by this placeholder.
 * - onMessageUpdated: Accept a source update; route its revision to the owners of affected
 *   evidence and conversation work without inventing missing original content.
 * - onMessageDeleted: Route source IDs and deletion metadata; do not infer who deleted it.
 * - onInteraction: Acknowledge or defer promptly; normalize to NormalizedInteractionDto; map the
 *   known command's arguments into its feature-owned request DTO and validate them at runtime.
 *   Use GuildLifecycleService.readInstallation and verified metadata to build TrustedCallerContext
 *   separately from user arguments.
 *   Invoke the named feature service, then serialize its public response DTO into the Discord reply.
 * - onGuildJoined: Notify GuildLifecycleService of a trusted installation event.
 * - onGuildRemoved: Notify GuildLifecycleService to suspend new work and begin cleanup.
 *
 * Collaborators:
 * DiscordInputNormalizer, feature-owned DTOs and explicitly exported context services. No context
 * repositories/entities or AI provider clients. Event/read/effect contracts stay with Discord.
 *
 * Invariants:
 * Create one fresh ORM context for each top-level event. Slow or disabled conversation handling
 * must not suppress moderation intake. This file routes events; feature services own eligibility
 * rules and durable progress.
 * Validation is explicitly wired into this event-handler path; do not assume an HTTP validation
 * pipe automatically runs for Discord events. Reject identity/authority fields in user arguments;
 * services recheck current authorization and business invariants. Keep handlers thin and split
 * them by feature only when the actual command set makes this file unwieldy.
 */
