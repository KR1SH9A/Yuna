/**
 * Planned component: CommunityModule
 * Kind: NestJS composition module
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Register ConversationService, KnowledgeService, ReplyDeliveryService and ReplyPolicy, with
 * private ConversationRequest, ReplyDelivery, ChannelReplySettings and KnowledgeEntry persistence.
 * Export ConversationService and KnowledgeService; composition-root delivery/recovery handlers may
 * receive the narrow delivery service.
 *
 * Scope:
 * Text conversation and approved knowledge are baseline features. Personal-memory enrichment is
 * enabled only when its feature scope ships.
 *
 * Planned methods:
 * No business methods planned. This file will describe dependency registration, private entity
 * registration and the narrow exported public services.
 *
 * Collaborators/Boundaries:
 * Consume Administration authority/safety APIs, optional Memory public APIs, Jobs, Usage, Audit
 * and narrow Discord read/action contracts. Never expose ORM entities or provider clients.
 *
 * Invariants:
 * Composition must not contain business decisions or conceal dependency cycles with forward
 * references.
 */
