/**
 * Planned component: MemoryContracts
 * Kind: Plain boundary contract catalogue
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the public serialized data boundary. Planned plain boundary types:
 * MemorySubjectScope: authenticated guild/user and purpose.
 * ConsentCommand and ConsentView: purpose-specific choice, audiences, retention and current
 * revision.
 * FactProposalAcceptance and EmbeddingAcceptance: bound stored result identity, scope,
 * source/content hash and privacy revision.
 * AudienceMemoryQuery and AuthorizedFactView: scoped purpose, destination and minimal permitted
 * fact values.
 * DisclosureBinding: scope/privacy revision plus fact and audience provenance for release/delivery
 * revalidation.
 * ForgetCommand and DeletionProgress: selected scope/facts, deletion generation and cleanup
 * status.
 *
 * Scope:
 * Staged until personal memory ships.
 *
 * Planned methods:
 * No business methods planned. These are conceptual data shapes, not runtime services,
 * declarations or implementations.
 *
 * Collaborators/Boundaries:
 * Plain contracts for private inspection, scoped retrieval, consent, result acceptance and
 * deletion. Community receives permitted values and bindings, never private entity references.
 *
 * Invariants:
 * A user able to read a private source is not automatically allowed to disclose it to a public
 * destination. Personal facts cannot establish staff authority. Memory consent is distinct from
 * debate consent.
 */
