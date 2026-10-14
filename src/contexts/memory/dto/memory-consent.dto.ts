/**
 * Planned component: MemoryConsentDtos
 * Kind: Staged external request and public response DTO catalogue
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the existing personal-memory consent interaction.
 *
 * Scope:
 * Staged until personal memory ships.
 *
 * Planned shapes:
 * - SetMemoryConsentRequestDto: inbound purpose-specific consent choice, requested audience and
 *   retention choice; consumed by MemoryService.setConsent.
 * - MemoryConsentResponseDto: outbound effective consent choice, permitted purpose/audience,
 *   retention and current privacy revision; produced by setConsent for the subject's interaction.
 *
 * Planned methods:
 * None. Future DTO validation checks supported choices and bounds only.
 *
 * Boundaries/invariants:
 * Administration's transport-neutral TrustedCallerContext is a separate service argument.
 * The owner resolves the subject/guild and permitted choices; the request cannot name a different
 * consenting actor or assert a current privacy revision. A visible response is not an internal
 * DisclosureBinding and cannot authorize later release or delivery of personal facts.
 */
