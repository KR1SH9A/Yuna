/**
 * Planned component: CustodianEnrollment
 * Kind: Context-private entity
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Track nominee acceptance and governed eligibility before custodian authority is created.
 *
 * Scope:
 * Optional; required only for multi-custodian governance.
 *
 * Planned fields:
 * id; guildId; candidateId; proposerId; governanceRevision; approvalReferences;
 * candidateAcceptedAt; status; resultingGrantReference; completedAt; rejectedAt; rejectionReason;
 * revision.
 *
 * Planned methods:
 * - recordAcceptance: Input: verified candidate acceptance of exact scope. Output: accepted
 *   nomination, not a grant.
 * - complete: Input: current eligible approvals and validated enrollment conditions. Output:
 *   completed status bound to a resulting grant.
 * - reject: Input: authorized rejection/cancellation cause. Output: terminal rejection without
 *   authority creation.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * Candidate cannot approve their own enrollment. Acceptance is not an independent governance
 * approval. Missing quorum leaves enrollment incomplete.
 */
