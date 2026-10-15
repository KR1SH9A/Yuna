/**
 * Planned component: KnowledgeService
 * Kind: Application Service
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Maintain approved guild resources and retrieve visible knowledge.
 *
 * Planned methods:
 * - approveEntry: Input: TrustedCallerContext and ApproveKnowledgeEntryDto. Output:
 *   KnowledgeEntryDto. Check current authorization and create immutable approved content,
 *   contentHash and provenance. For a correction, create a newly approved replacement and retire
 *   the same-installation/guild predecessor atomically using its expected rowRevision.
 * - changeVisibility: Input: TrustedCallerContext and ChangeKnowledgeVisibilityDto. Output:
 *   KnowledgeEntryDto. Authorize the requested audience independently, advance rowRevision and
 *   invalidate affected pending uses. Widening requires authority for the wider audience; this
 *   operation does not change or repeat content approval.
 * - retireEntry: Input: TrustedCallerContext and RetireKnowledgeEntryDto. Output:
 *   KnowledgeEntryDto describing retired state excluded from future eligible
 *   retrieval/publication.
 * - findVisibleEntries: Input: VisibleKnowledgeQueryDto plus verified source/installation and
 *   destination/audience facts for internal reply preparation; human lookups also supply
 *   TrustedCallerContext. Output: bounded list of KnowledgeEntryDto. Automatic preparation does
 *   not fabricate an interaction or treat the message author as granting bot authority. Apply
 *   current source/audience visibility before returning minimal approved values, content hash,
 *   access revision and provenance.
 *
 * Collaborators/Boundaries: Use owner-controlled MikroORM queries, Administration public APIs,
 * Jobs invalidation, Audit and narrow Discord contracts where current audience facts are needed.
 * Never import another context entity or provider SDK. Local writes join the caller transaction
 * or open one short transaction. External fact gathering enters outside an active transaction.
 *
 * DTO ownership: Use dto/knowledge.dto.ts. TrustedCallerContext from Administration is verified
 * caller provenance, not authority. Bot ingress maps verified Discord InteractionContextDto plus
 * the immutable installationId/guildId scope into that context and validates feature arguments
 * separately; generation may accompany that bound identity.
 * Services consume those plain values and normalized source provenance, never bot application
 * types or Discord SDK objects. Requested visibility and destination are arguments to validate,
 * never proof of access.
 *
 * Persistence ownership: use native MikroORM repositories/EntityManager for the private entities
 * registered by CommunityModule. Audience-visible knowledge and bounded delivery queries remain
 * owner-private query functions. No custom repository is justified yet; do not expose ORM
 * entities, lazy relations or repositories across the context boundary.
 *
 * Invariants: Knowledge belongs to Community, not Personal Memory. Retrieved text is contextual
 * data and cannot supply authority or executable instructions. Approved content changes only by
 * replacement; narrowing visibility or retirement invalidates pending uses in the same transaction.
 */
