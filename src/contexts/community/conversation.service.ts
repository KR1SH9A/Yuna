/**
 * Planned component: ConversationService
 * Kind: Application Service and persisted workflow coordinator
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Own one bounded reply from eligibility and authorized context preparation to
 * generation acceptance and delivery intent.
 *
 * Scope: Text baseline. Memory enrichment is staged. Add new methods when a concrete feature needs
 * them.
 *
 * Planned methods:
 * - receiveInput: Input: ConversationInputDto plus verified SourceProvenance, installation/audience
 *   values and current settings; explicit human interactions also supply TrustedCallerContext. Output:
 *   ConversationResultDto. Ordinary message intake does not require a fabricated interaction.
 *   Deduplicate, obtain
 *   visible knowledge and optional permitted memory, reserve work and atomically register the
 *   first task.
 * - acceptRoutingResult: Input: Jobs StoredResultReference from trusted completion routing.
 *   Output: applied, discarded(reason) or alreadyHandled. Load the stored
 *   result and validate expected task/stage, candidate membership, source/cancellation revisions
 *   and current bindings before advancing once.
 * - acceptReplyResult: Input: Jobs StoredResultReference from trusted completion routing. Output:
 *   applied, discarded(reason) or alreadyHandled. Validate expected stage, output/references,
 *   audience, privacy and original deadline. Copy accepted content/hash/allowed mentions into
 *   ReplyDelivery, prepare its destination-bound intent and record TaskAcceptance atomically.
 *   No external I/O occurs during acceptance; Jobs result references become provenance afterward.
 * - cancelRequest: Input: TrustedCallerContext and CancelConversationDto, or the existing verified
 *   system/source cancellation cause. Output: ConversationResultDto. Advance cancellation
 *   generation and invalidate pending work; track already-dispatched work separately.
 * - getConversationStatus: Input: TrustedCallerContext and exact owned request reference. Output:
 *   authorized ConversationResultDto with generation progress and delivery state derived from
 *   ReplyDelivery. Internal completion outcomes are not public status projections.
 *
 * Collaborators/Boundaries: Use owner-controlled MikroORM queries, Administration public APIs,
 * optional Memory public APIs, Jobs, Usage, Audit and narrow Discord contracts. Never import
 * another context entity or provider SDK. Local operations join the caller transaction or open one
 * short transaction. Any orchestration that obtains remote facts enters outside an active
 * transaction and performs external reads before local admission.
 *
 * DTO ownership: Use dto/conversation.dto.ts for public feature arguments and serialized progress.
 * Internal acceptance reuses Jobs StoredResultReference rather than accepting arbitrary provider
 * output. TrustedCallerContext from Administration is verified caller provenance, not authority.
 * For human interactions, bot ingress maps verified Discord InteractionContextDto plus the loaded
 * immutable installationId/guildId scope into that context and validates arguments separately.
 * Installation generation may accompany the bound identity. Ordinary message
 * intake supplies verified source provenance. Services consume those plain
 * values and normalized source provenance, never bot application types or Discord SDK objects.
 *
 * Persistence ownership: use native MikroORM repositories/EntityManager for the private entities
 * registered by CommunityModule. Audience-visible knowledge and bounded delivery queries remain
 * owner-private query functions. No custom repository is justified yet; do not expose ORM
 * entities, lazy relations or repositories across the context boundary.
 *
 * Interaction continuation: retain the bounded encrypted token/ack metadata on the request before
 * queuing generation; transfer it to delivery and clear the request copy on acceptance. Token
 * expiry does not authorize a channel fallback. Secrets never enter prepared model input.
 *
 * Invariants: Conversation pruning never suppresses moderation intake. Registration using memory
 * validates the disclosure binding in the same transaction. AI receives prepared values and cannot
 * choose authority or query context data. Pending message replies require current_source validity;
 * an edit does not extend the deadline or automatically create unlimited replacement workflows.
 * Cancellation can coexist with a later-confirmed already-dispatched delivery.
 */
