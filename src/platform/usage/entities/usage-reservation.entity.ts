/**
 * Planned component: UsageReservation
 * Kind: Mutable reservation-ledger entity
 * Owner: Platform / Usage
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Represent bounded capacity reserved for one task attempt or feature operation.
 *
 * Planned methods:
 * None. UsageService owns atomic admission, settlement and justified release.
 *
 * Planned fields:
 * Reservation ID; guild; provider/feature; task/attempt or operation reference; reserved bounded
 * amount and units; policy revision/spend window; expiry; settlement state; creation/update time;
 * row revision and accounting references.
 *
 * Boundaries/invariants:
 * Reserve against the applicable guild/provider budget atomically with competing reservations.
 * Bind settlement to the matching operation and deduplicate it. Expiry alone does not release a
 * possibly billed request; unresolved liability must survive the technical lease. Policy mutation
 * is not this record's responsibility. Tenant-scoped references cannot attach another guild's task
 * or usage entry.
 */
