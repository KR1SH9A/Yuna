/**
 * Planned component: ReplyDelivery
 * Kind: Context-private entity
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Record one accepted reply intent and its actual publication outcome.
 *
 * Planned fields:
 * id; guildId; requestId; acceptedResultReference; destination; privacy/audience binding;
 * deliveryState; generation; attemptMetadata; discordMessageId when known; outcomeDetails;
 * revision; createdAt; updatedAt.
 *
 * Planned methods:
 * - claimDispatch: Input: validated current gate and expected generation. Output: in-flight
 *   attempt with next generation.
 * - recordOutcome: Input: matching generation and normalized message/response evidence. Output:
 *   confirmed, definitive-failure or unresolved state.
 * - cancelBeforeDispatch: Input: invalidation cause. Output: canceled pending intent only;
 *   ambiguous in-flight work remains tracked.
 * - recordReconciliation: Input: attributable message evidence. Output: resolved delivery or
 *   retained uncertainty.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * Generation and delivery are separate facts. Missing message ID does not prove no send occurred.
 * Recheck current privacy/audience at the dispatch gate.
 */
