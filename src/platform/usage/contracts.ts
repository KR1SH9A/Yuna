/**
 * Planned component: Usage contracts
 * Kind: Plain reservation and accounting boundary types
 * Owner: Platform / Usage
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: Executable exact-money and usage snapshots live in the usage entities and user-usage.service.ts. This generic catalog is not a second runtime API.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility:
 * Describe trusted admission limits, reserved cost and attempt-specific accounting.
 *
 * Planned methods:
 * None. Future types describe a versioned policy snapshot, reservation request/result, attempt
 * usage, uncertain liability and unused-reservation release outcome.
 *
 * Planned fields:
 * Guild; feature/provider; task/attempt or operation identity; policy revision/window; bounded
 * estimated amount and unit; usage evidence/provider request reference; known or unresolved cost;
 * expiry; deduplication identity.
 *
 * Boundaries/invariants:
 * Policy values come from authorized callers, not model text or queue payload claims. Explicit
 * units and provider pricing/configuration avoid mixing tokens, duration and currency without a
 * defined conversion. Keep bounded integer/decimal representation choices for implementation; no
 * hard-coded prices belong in this contract. Timeout, stale result and rejected acceptance are not
 * evidence of zero provider cost.
 */
