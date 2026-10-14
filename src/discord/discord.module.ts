/**
 * Planned component: DiscordModule
 * Kind: Integration module
 * Owner: Discord boundary
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Register the Discord SDK connection, input normalizer, read adapter and effect adapter.
 *
 * Planned methods:
 * - None. Dependency registration only when implemented.
 *
 * Public provider exports:
 * DiscordInputNormalizer, DiscordStateReader and DiscordActions for bot/feature adapters.
 * DTOs under dto/ and read/effect values in contracts.ts are plain data imports, not DI providers.
 * The SDK connection/client remains private to this integration.
 *
 * Boundaries:
 * No business-context imports or repositories. Inbound handlers that call contexts live in
 * apps/bot, outside this integration module.
 */
