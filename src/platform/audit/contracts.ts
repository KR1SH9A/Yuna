/**
 * Planned component: Audit contracts
 * Kind: Plain audit-reference and correlation boundary types
 * Owner: Platform / Audit
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: Executable audit envelopes are defined in entities/audit-entry.entity.ts and validated by audit.recorder.ts. The generic catalog below is a design reference.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility:
 * Describe who or what authorized a change, what changed, and its durable references.
 *
 * Planned methods:
 * None. Future types describe transition and execution-outcome records with trusted authority
 * origin, owner references and explicit uncertainty.
 *
 * Planned fields:
 * Audit/correlation identity; guild; authenticated actor or enabled-policy origin; operation;
 * owner/context; case/finding/action/task/attempt references as applicable; revisions; timestamp;
 * outcome classification; external request/audit reference.
 *
 * Boundaries/invariants:
 * Automatic-policy authority and authenticated staff authority remain distinct. AI output cannot
 * supply trusted authorizing identity, target or operation. A logged dispatch, confirmed response
 * and observed external state are different facts. Records preserve uncertainty rather than
 * asserting unverified attribution. No raw prompts, secrets or full content copies when a scoped
 * reference is enough.
 */
