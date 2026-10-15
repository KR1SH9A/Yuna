/**
 * Planned component: Approved knowledge use-case DTOs
 * Kind: Use-case input/output DTO catalogue
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Describe approval, replacement, visibility, retirement and audience-visible
 * lookup operations; an approved knowledge record is not personal memory.
 *
 * Scope: Existing text use cases only; no additional product operations are introduced.
 *
 * Planned DTOs and fields:
 * - ApproveKnowledgeEntryDto (input): Exact bounded content and provenance references, requested
 *   visibility and optional predecessor entry reference/expected rowRevision for replacement.
 *   Approved content is never updated in place. The authenticated approver is supplied separately.
 * - ChangeKnowledgeVisibilityDto (input): Exact entry reference, expected rowRevision and requested
 *   audience. This does not change content or its approval metadata.
 * - RetireKnowledgeEntryDto (input): Exact entry reference, expected revision and bounded
 *   retirement reason.
 * - VisibleKnowledgeQueryDto (input): Bounded search terms/filters and result limit, with
 *   requested destination/reference sufficient for the owner to resolve audience. Caller and
 *   verified guild scope remain separate.
 * - KnowledgeEntryDto (output): Entry reference, contentHash/access rowRevision, permitted approved
 *   content and provenance, visibility binding and approval/retirement metadata for the caller.
 *   Never a live KnowledgeEntry entity.
 *
 * Runtime validation: Validate reference formats, content/search lengths, allowed visibility
 * values, revision shape and result limits. A requested audience/visibility is not proof of
 * access. KnowledgeService checks current authority and source/destination restrictions before
 * writing or returning values; render only authorized result fields.
 *
 * Planned methods: No business methods or queries planned. These comments describe plain
 * input/output data; validation implementation and its library are not chosen.
 *
 * Receiving/returning services: KnowledgeService receives these inputs with trusted caller/source
 * values and produces KnowledgeEntryDto or a bounded list. Approval/visibility/retirement and
 * human lookup use TrustedCallerContext. Automatic reply preparation supplies verified source,
 * installation and destination/audience values; it does not invent a human interaction.
 * Native owner queries perform visible
 * lookup; these DTOs contain no query execution or persistence behavior.
 *
 * Collaborators/Boundaries: Use existing ReplyAudienceBinding where a result needs a destination
 * constraint rather than defining another audience model. Approval identity comes from trusted
 * context. Provenance text is untrusted data and grants no capabilities.
 *
 * Trusted caller contract: User-invoked operations receive Administration TrustedCallerContext
 * separately from the feature DTO. It records verified provenance, not permission. System
 * completion/recovery calls instead use stored owner-bound references and trusted scheduling
 * scope. No parallel per-feature caller shape is defined.
 */
