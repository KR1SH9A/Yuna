/**
 * Planned component: MemoryContracts
 * Kind: Plain boundary contract catalogue
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe trusted subject bindings and internal/shared Memory values. External requests and
 * public responses live in dto/memory-consent.dto.ts, dto/inspect-memory.dto.ts and
 * dto/forget-memory.dto.ts; do not duplicate those shapes here. Planned plain boundary types:
 * MemorySubjectScope: authenticated guild/user and purpose.
 * FactProposalAcceptance and EmbeddingAcceptance: bound stored result identity, scope,
 * source/content hash and privacy revision.
 * AudienceMemoryQuery and AuthorizedFactView: scoped purpose, destination and minimal permitted
 * fact values.
 * DisclosureBinding: scope/privacy revision plus fact and audience provenance for release/delivery
 * revalidation.
 * DeletionProgress: owner-internal deletion generation and cleanup acknowledgment/status values
 * for lifecycle/recovery coordination; public display is mapped to MemoryDeletionResponseDto.
 *
 * Scope:
 * Staged until personal memory ships.
 *
 * Planned methods:
 * No business methods planned. These are conceptual data shapes, not runtime services,
 * declarations or implementations.
 *
 * Collaborators/Boundaries:
 * Plain internal contracts for scoped retrieval, result acceptance, disclosure and cleanup.
 * Interactive methods consume Administration's transport-neutral TrustedCallerContext separately
 * from their DTO arguments. Memory derives MemorySubjectScope from verified identity and current
 * consent; callers cannot assert another subject's scope. Community receives permitted values
 * and bindings, never private entity references or user-supplied authority.
 *
 * Invariants:
 * A user able to read a private source is not automatically allowed to disclose it to a public
 * destination. Personal facts cannot establish staff authority. Memory consent is distinct from
 * debate consent.
 */
