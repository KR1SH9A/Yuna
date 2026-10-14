/**
 * Planned component: ConversationRequest
 * Kind: Context-private entity
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Own one reply workflow stage and cancellation/delivery state.
 *
 * Planned fields:
 * id; guildId; channelId; trustedSource; authorId; sourceRevision; stage; expectedTaskId;
 * acceptedResultReference; audienceBinding; context/provenance references; deadline;
 * cancellationGeneration; revision; createdAt; updatedAt.
 *
 * Planned methods:
 * - expectTask: Input: task/stage and current source/context binding. Output: next expected task
 *   state after compatible-transition checks.
 * - acceptReply: Input: validated expected result and audience binding. Output: accepted reply
 *   reference for delivery preparation.
 * - cancel: Input: cancellation cause and expected revision. Output: advanced generation and
 *   canceled state without claiming in-flight effects were recalled.
 * - markDelivered: Input: confirmed matching delivery/message reference. Output: completed request
 *   state.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * Unique trusted request identity prevents duplicate event replies. Source edits/cancellation
 * invalidate old results. This is not an unbounded transcript.
 */
