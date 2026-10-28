/**
 * Planned component: InteractionContextDto
 * Kind: Trusted transport-context DTO
 * Owner: Discord boundary
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: Current authenticated command identity is DiscordCommandIdentity in contracts.ts; native authority facts are read through the gateway.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility:
 * Keep verified invocation identity separate from user-supplied operation arguments.
 *
 * Planned fields:
 * interactionId; verified actorId; guildId/channelId when present; source kind; observedAt.
 * Guild-only operations reject a context without a verified guild rather than accepting a guild
 * ID supplied in command options. Immutable installationId (UUID) and any lifecycle-generation
 * snapshot are loaded through Administration; neither is a Discord ID or a user argument.
 *
 * Producer and consumers:
 * DiscordInputNormalizer derives this value from authenticated Discord transport metadata.
 * DiscordHandlers calls GuildLifecycleService.readInstallation and maps this into Administration's
 * transport-neutral TrustedCallerContext. Feature modules own their DTOs; no feature imports apps/bot.
 *
 * Validation:
 * Validate identity/source shapes and require the trusted ingress construction path. Merely
 * deserializing an object with these fields never establishes an authenticated actor.
 *
 * Planned methods:
 * None. This DTO grants no permission and contains no service/SDK objects.
 *
 * Invariants:
 * Never merge user options into this object. Actor, guild and authority cannot be overridden by a
 * feature input DTO. Current Discord permissions, Yuna grants, safety and installation validity are
 * checked separately by their owning services; this is not an authorization snapshot.
 */
