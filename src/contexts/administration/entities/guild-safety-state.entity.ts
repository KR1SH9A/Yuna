/**
 * Planned component: GuildSafetyState
 * Kind: Context-private entity
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Represent the single lockable guild pause/revision gate.
 *
 * Planned fields:
 * guildId as unique key; pauseState; monotonicRevision; reason; actorAuthorityReference;
 * changedAt; rowRevision.
 *
 * Planned methods:
 * - pause: Input: verified cause/actor and expected revision. Output: paused state with advanced
 *   safety revision.
 * - resume: Input: validated resumption authority/configuration and expected revision. Output:
 *   active state with a further revision.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * Revisions never decrease. SafetyService acquires the lock, not this entity. Resume does not make
 * old bound intents current.
 */
