/**
 * Planned component: MemoryModule
 * Kind: NestJS composition module
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Register MemoryService and MemoryPolicy with private MemoryScope, MemoryFact, FactEmbedding and
 * MemoryDeletionRequest persistence.
 *
 * Planned exports:
 * MemoryService only, including its scoped operations and disclosure validation. DTO catalogues
 * and plain contracts describe its boundary; they do not register runtime providers.
 *
 * Private registrations:
 * MemoryPolicy and all four records with their native MikroORM repositories. Keep queries and
 * persistence inside MemoryService; do not export entities, repositories, EntityManager or the
 * policy implementation.
 *
 * Scope:
 * Staged feature: activate when personal-memory retrieval ships. No runtime memory feature is
 * implemented by this scaffold.
 *
 * Planned methods:
 * No business methods planned. This file will describe dependency registration, private entity
 * registration and the narrow exported public services.
 *
 * Collaborators/Boundaries:
 * Consume Administration APIs where authority is required, Jobs, Usage, Artifacts and plain
 * embedding/task contracts. Community calls this public API; no consumer reads private memory
 * tables.
 *
 * Invariants:
 * Composition must not contain business decisions or conceal dependency cycles with forward
 * references.
 */
