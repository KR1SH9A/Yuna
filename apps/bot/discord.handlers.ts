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
 * - onMessageUpdated: Record the observed current-source state and invalidate affected Community
 *   work. Do not replace Moderation's original capture or reassess the edited body as original.
 * - onMessageDeleted: Record source tombstones, including per-message entries for bulk deletion;
 *   invalidate current-source work without erasing independently retained original evidence.
 * - onInteraction: Acknowledge or defer promptly; normalize to NormalizedInteractionDto; map the
 *   known command's arguments into its feature-owned request DTO and validate them at runtime.
 *   Use GuildLifecycleService.readInstallation and verified metadata to build TrustedCallerContext
 *   separately from user arguments.
 *   Invoke the named feature service, then serialize its public response DTO into the Discord reply.
 * - onGuildJoined: Distinguish initial guild loading/reavailability from a verified new
 *   installation. A GUILD_CREATE event alone does not require a fresh installation generation.
 * - onGuildRemoved: Distinguish temporary unavailability from confirmed removal. Update
 *   availability only for outages; confirmed removal begins cleanup for the exact installation.
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
 * Interaction acknowledgment/defer must meet Discord's transport deadline before slow work.
 * A guild-context interaction does not itself prove a current guild installation. Tokens remain
 * in a short-lived protected transport continuation, never in Jobs payloads or audit records.
 */
