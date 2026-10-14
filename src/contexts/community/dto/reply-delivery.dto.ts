/**
 * Planned component: Reply delivery result DTOs
 * Kind: Use-case input/output DTO catalogue
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Describe existing publication/recovery outcomes without adding a request wrapper
 * for every internal effect parameter.
 *
 * Scope: Existing text use cases only; no additional product operations are introduced.
 *
 * Planned DTOs and fields:
 * - ReplyDeliveryOutcomeDto (output): Delivery and request references, local delivery state,
 *   separate confirmed/definitive-failure/unknown outcome, optional established Discord message
 *   reference and minimal permitted reason.
 * - ReplyRecoveryResultDto (output): Bounded processed/deferred counts and unresolved delivery
 *   references with summarized outcomes for the requested trusted recovery scope.
 *
 * Runtime validation: Validate output state/outcome combinations and conditional message
 * references against persisted owner facts. Do not turn generated text or a dispatch claim into
 * confirmed delivery. Keep recovery responses bounded and free of copied private reply context.
 *
 * Planned methods: No business methods or queries planned. These comments describe plain
 * input/output data; validation implementation and its library are not chosen.
 *
 * Receiving/returning services: ReplyDeliveryService returns these DTOs to its existing callers.
 * Inputs remain internal accepted-reply/audience bindings, delivery IDs, normalized
 * DiscordOperationResult with attempt binding and bounded recovery criteria; no generic delivery
 * command is introduced.
 *
 * Collaborators/Boundaries: ConversationRequest and ReplyDelivery entities stay private.
 * ReplyAudienceBinding is reused from ../contracts.ts; optional Memory disclosure validation
 * remains with Memory. DTO validation does not replace current dispatch gates.
 *
 * Trusted caller contract: User-invoked operations receive Administration TrustedCallerContext
 * separately from the feature DTO. It records verified provenance, not permission. System
 * completion/recovery calls instead use stored owner-bound references and trusted scheduling
 * scope. No parallel per-feature caller shape is defined.
 */
