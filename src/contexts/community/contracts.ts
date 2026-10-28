/**
 * Planned component: CommunityContracts
 * Kind: Narrow context bindings
 * Owner: Community
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: Current Community boundaries are defined in generation/conversation task contracts, knowledge DTOs and Discord plain-data contracts. This wider catalog is a design reference.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility: Keep audience/provenance bindings separate from public use-case arguments and
 * results.
 *
 * Planned values:
 * - ReplyAudienceBinding: resolved destination, permitted visibility, source/provenance references
 *   and applicable privacy revisions. This is a current checked binding, not an arbitrary audience
 *   requested by a user.
 * - ReplyDestination: discriminated channel_message or interaction_original binding. Channel
 *   delivery carries its channel and explicit reply reference; interaction delivery carries its
 *   application/interaction identity, protected continuation reference, token expiry and fixed
 *   visibility. Plain interaction tokens never cross into Jobs, audit or logs.
 *
 * DTO locations:
 * - dto/conversation.dto.ts owns conversation/cancellation arguments and ConversationResultDto
 *   progress.
 * - dto/knowledge.dto.ts owns approve/replace/visibility/retire/visible-lookup arguments and
 *   KnowledgeEntryDto views.
 * - dto/reply-delivery.dto.ts owns delivery outcomes and bounded recovery summaries.
 *
 * Trusted and infrastructure values: Reuse TrustedCallerContext from Administration contracts. Bot
 * ingress maps verified Discord metadata plus current installation scope into that plain context
 * separately from validated feature arguments. SourceProvenance and DiscordOperationResult reuse
 * plain Discord boundary contracts. Internal completion methods reuse Jobs StoredResultReference
 * and acceptance bindings instead of parallel routing/reply-result request types. Optional Memory
 * disclosure bindings come from Memory public operations.
 *
 * Scope: Text baseline; optional feature fields are added only for concrete released contracts.
 *
 * Planned methods: No business methods planned. Bindings are plain values; the referenced DTO
 * files describe arguments/results, not queries or service implementations.
 *
 * Collaborators/Boundaries: Services consume caller/source values and feature DTOs without bot app
 * or transport SDK imports. DTO definitions are not duplicated here. Entities, lazy relations and
 * repositories remain private to Community.
 *
 * Invariants: Routing or generated text cannot establish actor identity or authority. Requested
 * destination/access must be checked before producing a ReplyAudienceBinding. Preserve each
 * source's original provenance.
 */
