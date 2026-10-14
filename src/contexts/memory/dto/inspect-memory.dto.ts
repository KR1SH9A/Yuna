/**
 * Planned component: InspectMemoryDtos
 * Kind: Staged public response DTO catalogue
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the existing private inspection of the authenticated subject's facts in one guild.
 *
 * Scope:
 * Staged until personal memory ships.
 *
 * Planned shapes:
 * - OwnMemoryFactsResponseDto: outbound minimal fact references and permitted personal fact
 *   values with their visible purpose, retention and privacy revision information; produced by
 *   inspectOwnFacts for a private response to the verified owner.
 *
 * Planned methods:
 * None. No empty request DTO is needed; inspectOwnFacts consumes the verified owner and
 * explicitly selected guild binding separately.
 *
 * Boundaries/invariants:
 * TrustedCallerContext arrives separately; an adapter resolves the selected guild before the
 * service verifies subject access. Response values exclude embeddings, private storage handles
 * and ORM objects. The ability to inspect these facts does not permit public disclosure.
 * Internal audience retrieval keeps its separate contracts in ../contracts.ts.
 */
