/**
 * Planned component: UsageModule
 * Kind: NestJS infrastructure composition module
 * Owner: Platform / Usage
 * Status: Navigation/design reference; runtime ownership is described below.
 *
 * Current implementation: UsageService and UserUsageService are implemented; task SQL owns atomic reservation/settlement. Composition roots wire the owners directly.
 * The remaining planned catalog is not an additional required implementation.
 *
 * Responsibility:
 * Wire atomic reservations and provider-attempt cost accounting.
 *
 * Planned methods:
 * None. Future wiring registers UsageService, UsageReservation and UsageEntry with the permitted
 * bot/worker operations and transaction-scoped persistence support.
 *
 * Boundaries/invariants:
 * Administration owns usage policy; callers supply trusted versioned policy values. This module
 * does not import Administration's entities or query business repositories. Workers can record
 * only the permitted task-attempt usage, not rewrite budget policy. No general authorization
 * engine, provider facade or queue scheduler belongs here.
 */
