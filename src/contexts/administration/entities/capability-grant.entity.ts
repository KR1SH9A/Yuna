/**
 * Planned component: CapabilityGrant
 * Kind: Context-private entity
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Bind a guild capability to a named grantee and scope.
 *
 * Planned fields:
 * id; guildId; granteePrincipal; capability; target/channel scope; grantorPrincipal; grantedAt;
 * expiresAt; revokedAt; authorityRevision; revocationReason; revision.
 *
 * Planned methods:
 * - revoke: Input: authorized reason/time and expected revision. Output: revoked authority
 *   revision.
 * - isCurrentFor: Input: exact operation/target/channel and time. Output: local validity only;
 *   services still obtain current authority/native facts.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * Grantee and grantor are recorded separately; eligibility and self-grant restrictions follow
 * authority policy. Yuna capability does not replace native permission. Checkpoints, display names
 * and model output cannot revive revoked grants.
 */
