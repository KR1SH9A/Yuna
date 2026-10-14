/**
 * Planned component: ModerationPolicyRevision
 * Kind: Immutable retained record
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe one immutable set of guild moderation rule and action-acceptance values.
 *
 * Planned fields:
 * id; guildId; revision; enabledRules; requiredEvidence; exclusions;
 * evaluationConfigurationVersions; actionMapping; activationTime; createdAt.
 *
 * Planned methods:
 * No mutation methods planned. Publish a new revision for policy changes; application workflow
 * updates active references and invalidates affected pending decisions.
 *
 * Collaborators/Boundaries:
 * Private context-owned persistence record. The owning service loads and persists it through
 * MikroORM in the caller's transaction. Transition methods operate on supplied values only; they
 * do not query, enqueue, or call external systems.
 *
 * Invariants:
 * In-flight work never silently adopts newer rules. This record contains policy values, not live
 * permissions or model-provider clients. Tenant references must remain in one guild through
 * database-enforced constraints. Internal IDs are UUIDs; Discord IDs are strings. Row revision and
 * conditional writes protect mutable transitions; entity checks alone do not replace concurrency
 * constraints.
 */
