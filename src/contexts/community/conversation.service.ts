/**
 * Planned component: ConversationService
 * Kind: Application Service and persisted workflow coordinator
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Own one bounded reply from eligibility and authorized context preparation to generation
 * acceptance and delivery intent.
 *
 * Scope:
 * Text baseline. Memory enrichment is staged. Add new methods when a concrete feature needs them.
 *
 * Planned methods:
 * - receiveInput: Input: normalized source/author/guild, untrusted content and current settings.
 *   Output: request reference or eligibility decision. Deduplicate, obtain visible knowledge and
 *   optional permitted memory, reserve work and atomically register the first task.
 * - acceptRoutingResult: Input: stored task/result identity. Output: accepted routing or rejection
 *   and any next task. Validate expected task/stage, candidate membership, source/cancellation
 *   revisions and current bindings before advancing once.
 * - acceptReplyResult: Input: stored generation result identity. Output: accepted reply/delivery
 *   intent or rejection. Validate expected stage, output/references, audience and privacy
 *   revisions; accept and prepare delivery atomically.
 * - cancelRequest: Input: authenticated cancellation cause and request ID. Output: advanced
 *   cancellation generation plus pending-work invalidation. Track already-dispatched work
 *   separately.
 *
 * Collaborators/Boundaries:
 * Use owner-controlled MikroORM queries, Administration public APIs, optional Memory public APIs,
 * Jobs, Usage, Audit and narrow Discord contracts. Never import another context entity or provider
 * SDK. Nested operations join the caller transaction; external calls occur outside transactions.
 *
 * Invariants:
 * Conversation pruning never suppresses moderation intake. Registration using memory validates the
 * disclosure binding in the same transaction. AI receives prepared values and cannot choose
 * authority or query context data.
 */
