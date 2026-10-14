/**
 * Planned component: UsageEntry
 * Kind: Provider-attempt accounting record
 * Owner: Platform / Usage
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Record known usage or unresolved estimated liability for one provider attempt.
 *
 * Planned methods:
 * None. UsageService records and reconciles accounting through bounded operations.
 *
 * Planned fields:
 * Entry ID; guild; provider; attempt/operation and reservation references; provider request
 * reference; known actual or unresolved estimated cost; units; accounting state;
 * evidence/timestamps; reconciliation metadata and row revision when mutable.
 *
 * Boundaries/invariants:
 * Deduplicate the same provider attempt without collapsing separately billed retries. Business
 * acceptance and provider billing are independent facts; rejected or stale results may still incur
 * cost. Keep uncertainty until usage evidence resolves it. Do not overwrite task identity, policy
 * limits or business decisions from this record. Do not retain raw private prompts when accounting
 * references are sufficient.
 */
