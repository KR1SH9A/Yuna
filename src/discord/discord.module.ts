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
 * Public components:
 * DiscordInputNormalizer, DiscordStateReader, DiscordActions and plain contracts.
 *
 * Boundaries:
 * No business-context imports or repositories. Inbound handlers that call contexts live in
 * apps/bot, outside this integration module.
 */
