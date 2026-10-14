/**
 * Planned component: CommunityContracts
 * Kind: Plain boundary contract catalogue
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the public serialized data boundary. Planned plain boundary types:
 * ConversationInput: authenticated guild, source kind/reference/revision, author and untrusted
 * content kept separate.
 * ReplyAudienceBinding: destination, visibility, provenance and applicable privacy revisions.
 * ConversationCommand and ConversationView: named request/cancellation inputs and serialized
 * progress.
 * RoutingAcceptance and ReplyAcceptance: stored task/result identifiers and expected stage
 * bindings.
 * VisibleKnowledgeQuery and KnowledgeEntryView: caller/audience-scoped retrieval data.
 * ReplyDeliveryOutcome: confirmed, definitive failure or unresolved delivery information.
 *
 * Scope:
 * Text baseline; optional feature fields are added only for concrete released contracts.
 *
 * Planned methods:
 * No business methods planned. These are conceptual data shapes, not runtime services,
 * declarations or implementations.
 *
 * Collaborators/Boundaries:
 * Expose plain command, query and result data to bot handlers and permitted context consumers.
 * Preserve each input's original source kind and provenance when adding new features.
 *
 * Invariants:
 * Never return a live entity/lazy relation. A routing or generation result grants neither
 * authority nor a trusted actor identity. Memory disclosure bindings originate from Memory public
 * operations.
 */
