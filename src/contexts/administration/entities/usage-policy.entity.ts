/**
 * Planned component: UsagePolicy
 * Kind: Context-private entity
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Hold shared versioned limits while Usage infrastructure accounts for consumption.
 *
 * Planned fields:
 * id; guildId; featureLimits; providerLimits; spendWindow; spendCeilings; revision; effectiveAt;
 * updatedAt.
 *
 * Planned methods:
 * - revise: Input: already-authorized bounded values and expected revision. Output: next policy
 *   revision after local coherence checks; admitted reservations retain their original binding and
 *   actual costs.
 *
 * Collaborators/Boundaries:
 * Context-private MikroORM entity. The owner service loads/persists it in the caller transaction.
 * Methods use supplied values only; no queries, networking or queue calls. Database constraints
 * enforce same-guild references and uniqueness. Internal IDs are UUIDs; Discord IDs are strings.
 * Conditional writes/row revisions protect concurrent mutation.
 *
 * Invariants:
 * No usage counters, reservations or provider bills belong here. Usage infrastructure enforces
 * supplied policy atomically without defining it.
 */
