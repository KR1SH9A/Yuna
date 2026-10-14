/**
 * Planned component: ChannelReplySettings
 * Kind: Context-private entity
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Store one channel reply mode and approved knowledge scope.
 *
 * Planned fields:
 * id; guildId; channelId; mode; allowedKnowledgeScope; revision; updatedAt.
 *
 * Planned methods:
 * - changeMode: Input: already-authorized mode and expected revision. Output: revised
 *   silent/direct/proactive setting.
 * - changeKnowledgeScope: Input: already-authorized source scope and expected revision. Output:
 *   revised retrieval eligibility; services invalidate affected pending work.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * Unique guild/channel record. Silent conversation mode does not disable independently enabled
 * moderation.
 */
