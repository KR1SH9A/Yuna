/**
 * Planned component: TaskService
 * Kind: Bot-side application infrastructure facade
 * Owner: Platform / Jobs
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Maintain technical work records while the calling context owns workflow progression.
 *
 * Planned methods:
 * - readTaskDescriptor: trusted bot consumer and task ID -> TaskDescriptor or absence. Return
 *   stored installationId/guildId, owner, operation/workflow reference, kind/schema version and
 *   deadline so CompletionHandlers can select the known owner before reading its result. No input/result
 *   payload, artifact access or business entity is returned; this read is not acceptance.
 * - registerTask: trusted registration and prepared input -> task reference. Persist immutable
 *   binding, eligible work and outbox signal in the caller's transaction.
 * - readStoredResult: trusted installation/guild, task and optional result identity -> stored bound
 *   result view or absence. Never substitute a result supplied by queue/model text.
 * - recordAcceptance: current expected-task binding and context decision -> accepted, discarded or
 *   already recorded acknowledgment. Join the transaction that verifies the owning workflow and
 *   copies accepted owner output and applies its transition; acknowledge the result once, including
 *   discards. A duplicate returns the existing disposition.
 * - cancelTask: trusted owner/task and cancellation reason -> cancellation outcome. Invalidate
 *   undisclosed work and fence late results without claiming remote recall. If still nonterminal,
 *   atomically finalize one canceled TaskResult and completion outbox; never rewrite an existing
 *   terminal result.
 * - invalidatePreparedWork: trusted scope/revision and affected bindings -> invalidation
 *   acknowledgment. Revoke worker input eligibility in the owner's transaction using declared
 *   sourceUse dependencies; edits/deletion alone do not invalidate retained original_evidence.
 *   Retain durable cleanup work for copied payloads/artifacts.
 *
 * Boundaries/invariants:
 * No business stage selection, provider calls or context repository access. Registration,
 * acceptance and invalidation join the caller transaction or open one short transaction when
 * called independently. Owner checks, accepted output/next intent and expected-task changes are
 * atomic with acknowledgment; deliberate reassessment uses a new operation key/task. Never make
 * workflow/stage unique. Input invalidation and release share a database gate. Released input is
 * in flight; later cancellation cannot promise recall of data
 * or refund provider usage.
 */
