/**
 * Planned component: PlanApproval
 * Kind: Context-private entity
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Bind an eligible approval to exact plan content and validity conditions.
 *
 * Scope:
 * Optional; instantiate only for released governance workflows.
 *
 * Planned fields:
 * id; guildId; planId; planHash; approverId; approverAuthorityRevision; scope; approvedAt;
 * expiresAt; consumedAt; invalidatedAt; invalidationReason; revision.
 *
 * Planned methods:
 * - consume: Input: matching current plan/authority and consumption identity. Output: approval
 *   consumed for one authorized execution.
 * - invalidate: Input: revocation, expiry or plan mismatch. Output: unusable approval preserving
 *   its original decision metadata.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * Approver must be unique per plan and different from excluded identities. Current authority is
 * revalidated before consumption.
 */
