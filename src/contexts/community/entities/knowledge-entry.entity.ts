/**
 * Planned component: KnowledgeEntry
 * Kind: Context-private entity
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Keep approved information, source provenance, audience visibility and retirement.
 *
 * Planned fields:
 * id; guildId; content; provenance; approvalActorId; approvedAt; visibility; revision; retiredAt;
 * createdAt; updatedAt.
 *
 * Planned methods:
 * - approve: Input: verified approver and exact content/visibility revision. Output: approval
 *   metadata bound to that revision.
 * - retire: Input: authorized cause/time and expected revision. Output: retired state; services
 *   stop eligible use of the entry.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * Approval applies to exact content, not later edits. Visibility is never widened by a model
 * selecting the entry. Knowledge is neither personal memory nor authority.
 */
