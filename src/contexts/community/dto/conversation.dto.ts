/**
 * Planned component: Conversation use-case DTOs
 * Kind: Use-case input/output DTO catalogue
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Describe ordinary text-reply arguments, cancellation arguments and serialized
 * request progress independently of authenticated source metadata.
 *
 * Scope: Existing text use cases only; no additional product operations are introduced.
 *
 * Planned DTOs and fields:
 * - ConversationInputDto (input): Bounded message text, permitted attachment references,
 *   referenced-message candidate and capture completeness markers. Verified
 *   actor/guild/channel/source identity and authoritative revision are supplied separately.
 * - CancelConversationDto (input): Exact conversation request reference and bounded cancellation
 *   reason. No client-supplied cancellation generation, trusted actor or authority.
 * - ConversationResultDto (output): Request reference, eligibility/progress/terminal status,
 *   expected stage summary when appropriate, optional accepted result/delivery reference and
 *   minimal permitted reason. Delivery state is derived from ReplyDelivery, independently of
 *   generation cancellation. Do not expose private context, interaction tokens or ORM entities.
 *
 * Runtime validation: Validate lengths, attachment/reference counts, reference formats and allowed
 * input structure at ingress. The service resolves reply references, checks guild/source ownership
 * and current eligibility/audience. Cancellation access is checked using the separate trusted
 * caller. Output status reflects persisted progress, not assumed delivery.
 *
 * Planned methods: No business methods or queries planned. These comments describe plain
 * input/output data; validation implementation and its library are not chosen.
 *
 * Receiving/returning services: ConversationService consumes the argument DTOs and returns
 * ConversationResultDto for authorized use cases/status reads. Completion handlers pass Jobs
 * StoredResultReference to acceptance methods and receive applied, discarded(reason) or
 * alreadyHandled; provider payloads are read from stored results rather than a public DTO.
 *
 * Collaborators/Boundaries: ReplyAudienceBinding remains in ../contracts.ts. Ingress maps verified
 * Discord metadata to separate trusted caller/source values, with no bot-app or SDK objects
 * entering Community. Preserve text provenance; optional fields require a concrete released use
 * case.
 *
 * Trusted caller contract: User-invoked operations receive Administration TrustedCallerContext
 * separately from the feature DTO. It records verified provenance, not permission. System
 * completion/recovery calls instead use stored owner-bound references and trusted scheduling
 * scope. No parallel per-feature caller shape is defined.
 */
