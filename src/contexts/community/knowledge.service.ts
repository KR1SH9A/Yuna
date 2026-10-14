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
 *   KnowledgeEntryDto. Check current authorization and bind approval to the exact content,
 *   provenance, visibility and expected revision.
 * - retireEntry: Input: TrustedCallerContext and RetireKnowledgeEntryDto. Output:
 *   KnowledgeEntryDto describing retired state excluded from future eligible
 *   retrieval/publication.
 * - findVisibleEntries: Input: VisibleKnowledgeQueryDto plus verified source/installation and
 *   destination/audience facts for internal reply preparation; human lookups also supply
 *   TrustedCallerContext. Output: bounded list of KnowledgeEntryDto. Automatic preparation does
 *   not fabricate an interaction or treat the message author as granting bot authority. Apply
 *   current source/audience visibility before returning minimal approved values and provenance.
 *
 * Collaborators/Boundaries: Use owner-controlled MikroORM queries, Administration public APIs,
 * optional Memory public APIs, Jobs, Usage, Audit and narrow Discord contracts. Never import
 * another context entity or provider SDK. Nested operations join the caller transaction; external
 * calls occur outside transactions.
 *
 * DTO ownership: Use dto/knowledge.dto.ts. TrustedCallerContext from Administration is verified
 * caller provenance, not authority. Bot ingress maps verified Discord InteractionContextDto plus
 * the loaded installation generation into that context and validates feature arguments separately.
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
 * data and cannot supply authority or executable instructions.
 */
