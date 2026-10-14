/**
 * Planned component: MemoryService
 * Kind: Application Service and privacy lifecycle owner
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Own consent, proposals, fact/embedding acceptance, authorized retrieval and physical deletion of
 * personal memory.
 *
 * Scope:
 * Staged feature: activate only when personal memory ships.
 *
 * Planned methods:
 * - setConsent: Input: authenticated guild/user, purpose, audience and retention choice. Output:
 *   current consent/privacy binding. Serialize scope changes and atomically invalidate affected
 *   prepared work through Jobs when consent narrows or is revoked.
 * - proposeFacts: Input: consented attributable source and current subject/purpose binding.
 *   Output: bounded proposal task reference. Apply storage policy and reserve/register work
 *   without making AI output authoritative.
 * - acceptFactProposal: Input: stored proposal result reference and expected scope/source/privacy
 *   binding. Output: accepted fact reference or rejection. Load the bound result and validate
 *   subject, sensitivity, provenance and current consent before accepting once. Store the
 *   permitted fact; register an embedding task only when embedding retrieval is enabled.
 * - acceptEmbeddingResult: Input: stored embedding result reference, existing fact identity/hash
 *   and current privacy revision. Output: attached vector or rejection. Load the bound result and
 *   atomically validate the existing fact, consent and model/version/dimensions. Never recreate a
 *   deleted fact; facts can exist without embeddings.
 * - retrieveForAudience: Input: authenticated subject scope, purpose, destination audience and
 *   bounded query. Output: minimal authorized facts plus disclosure binding. Filter
 *   guild/user/consent/expiry/source access/audience before similarity results enter context.
 * - validateDisclosureBinding: Input: prepared fact/scope/audience binding and caller transaction.
 *   Output: current disclosure validity or stale/revoked denial. Participate in input admission
 *   and delivery-claim transactions without exposing private entities.
 * - inspectOwnFacts: Input: verified owner identity and explicit selected guild. Output: private
 *   minimal fact views. Do not expose a profile in a public channel.
 * - forget: Input: authenticated scope/fact selection and expected privacy revision. Output:
 *   deletion generation/progress. Advance revision, physically remove content/vectors and
 *   atomically call TaskService.invalidatePreparedWork; record retryable cleanup for copied
 *   inputs, replies, artifacts and caches through their owners.
 * - expireFacts: Input: bounded guild/scope/time criteria. Output: expiry/deletion progress.
 *   Select owned expired records, apply the same revision/invalidation protocol and continue
 *   tracked owner cleanup without app-level table reads.
 *
 * Collaborators/Boundaries:
 * Use Memory-owned repositories, MemoryPolicy, Jobs, Usage, Audit, artifact mechanics and plain
 * proposal/embedding contracts. Other contexts call this public API; do not export ORM entities.
 * Never query moderation evidence, Community knowledge or debate transcripts. All nested mutations
 * join the caller transaction.
 *
 * Invariants:
 * Privacy checks occur at preparation, input release, acceptance and delivery boundaries. Jobs
 * owns technical eligibility records; it never reads Memory tables or chooses privacy policy.
 * Physical cleanup can lag after gates invalidate disclosure; record its progress.
 * Already-released provider input or delivered output cannot be recalled by a database change.
 * Consent for memory does not imply debate consent.
 */
