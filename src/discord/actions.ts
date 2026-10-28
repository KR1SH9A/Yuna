/**
 * Planned component: DiscordActions
 * Kind: Outbound effect adapter
 * Owner: Discord boundary
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: DiscordGateway, DiscordModerationTransport and DiscordDebateTransport implement current sends, warnings and ban/unban/kick effects.
 * The planned kickMember method is the kick branch of DiscordModerationTransport.execute, with
 * current membership/permission/hierarchy preparation and attempt-bound audit reconciliation.
 * Kick command registration and live admission remain a separate composition decision.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility:
 * Execute exact operations already authorized and recorded by their feature owner.
 *
 * Planned methods:
 * - banMember: Receive an owner-recorded exact guild/account payload and audit correlation;
 *   request a ban with only explicitly authorized history-deletion parameters.
 * - unbanMember: Receive guild/account and recorded staff authority reference.
 * - kickMember: Receive guild/target and recorded staff action reference.
 * - sendMessage: Receive authorized destination, content and mention constraints; return the
 *   message reference or an explicit failed/unknown outcome.
 * - respondToInteraction: Receive an interaction reference and permitted reply content;
 *   acknowledge, defer or respond using the supported interaction path.
 *
 * Boundaries:
 * No case repositories, rule selection, approval decisions or model calls. Respect external rate
 * limits; expose uncertainty instead of blind retries. The calling service records and reconciles
 * outcomes. Adapter calls always run outside an active database transaction and cannot silently
 * alter the recorded target, content, operation or history-deletion options. Ban/unban/kick success
 * returns no action ID (204); message creation can return a message ID. A send correlation/nonce
 * is not unlimited idempotency: enforce_nonce covers only the documented recent-message window.
 */
