/**
 * Planned component: CommunityModule
 * Kind: NestJS composition module
 * Owner: Community
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: ConversationService, KnowledgeService and ReplyDeliveryService are wired directly in apps/bot/bot.module.ts. No framework module is required.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility: Register ConversationService, KnowledgeService, ReplyDeliveryService and
 * ReplyPolicy, with private ConversationRequest, ReplyDelivery, ChannelReplySettings and
 * KnowledgeEntry persistence. Explicit public service exports: ConversationService,
 * KnowledgeService and ReplyDeliveryService. Bot dispatch/recovery handlers inject the exported
 * ReplyDeliveryService. Keep ReplyPolicy, all four entities and native repository providers
 * private.
 *
 * Scope: Text conversation and approved knowledge are baseline features. Personal-memory
 * enrichment is enabled only when its feature scope ships.
 *
 * Planned methods: No business methods planned. This file will describe dependency registration,
 * private entity registration and the narrow exported public services.
 *
 * Collaborators/Boundaries: Consume Administration authority/safety APIs, optional Memory public
 * APIs, Jobs, Usage, Audit and narrow Discord read/action contracts. Never expose ORM entities or
 * provider clients.
 *
 * Persistence and DTO wiring: Register owned entities with native MikroORM repository providers in
 * this module; owning services use those providers directly. No custom repository or generic CRUD
 * wrapper is introduced. DTO catalogues are plain boundary descriptions, not DI service providers.
 * Exported services return DTO/plain binding values rather than entities.
 *
 * Invariants: Composition must not contain business decisions or conceal dependency cycles with
 * forward references.
 */
