/**
 * Planned component: GuildInstallation
 * Kind: Context-private entity
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Own one installation generation and whether new work is admitted.
 *
 * Planned fields:
 * id; guildId; state including active/suspended/removing/removed; installationGeneration;
 * configurationReferences; registeredAt; removedAt; revision; updatedAt.
 *
 * Planned methods:
 * - activate: Input: verified bootstrap/reinstallation conditions and expected revision. Output:
 *   active state and fresh generation where required.
 * - suspend: Input: trusted cause. Output: suspended state and advanced generation.
 * - beginRemoval: Input: verified cause. Output: removing state and advanced generation.
 * - completeRemoval: Input: required cleanup acknowledgments. Output: removed state without
 *   reviving old authority/work.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * Prior installation work remains fenced. Entity transitions do not perform cleanup; services
 * coordinate invalidation and owner acknowledgments.
 */
