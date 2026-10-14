/**
 * Planned component: DiscordInputNormalizer
 * Kind: Inbound adapter
 * Owner: Discord boundary
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Translate SDK event shapes into explicit application input values.
 *
 * Planned methods:
 * - normalizeMessage: Receive a Discord message event and produce normalized source metadata,
 *   content, attachments and completeness information.
 * - normalizeInteraction: Receive a verified interaction and produce trusted actor metadata
 *   separately from user-supplied operation arguments.
 * - normalizeMessageRevision: Receive an edit/delete event and describe only the source change
 *   actually known; missing fields stay explicitly missing.
 *
 * Boundaries:
 * No database writes, policy decisions, inference, or routing to context services. Preserve
 * reporter versus original author and bot/webhook versus human provenance.
 */
