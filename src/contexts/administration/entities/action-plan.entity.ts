/**
 * Planned component: ActionPlan
 * Kind: Context-private entity
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Bind sensitive optional governance approval to immutable operations and one-time consumption.
 *
 * Scope:
 * Optional; instantiate only for released governance workflows.
 *
 * Planned fields:
 * id; guildId; exactOperations; planHash; requesterId; scope; expiresAt; authorityBinding; status;
 * consumedAt; consumptionReference; revision; createdAt.
 *
 * Planned methods:
 * - consume: Input: fresh distinct eligible approvals and exact expected plan/hash/authority.
 *   Output: consumed authorization once; reject changed, expired or invalidated plans.
 * - invalidate: Input: changed authority, cancellation or scope cause and expected revision.
 *   Output: unusable status; operation content remains immutable.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * Changed operations require a new plan. Requester and enrollment candidate cannot approve
 * themselves. A plan is not a reusable approved flag.
 */
