/**
 * Planned component: ForgetMemoryDtos
 * Kind: Staged external request and public response DTO catalogue
 * Owner: Memory
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the existing request to forget selected facts or the subject's permitted scope.
 *
 * Scope:
 * Staged until personal memory ships.
 *
 * Planned shapes:
 * - ForgetMemoryRequestDto: inbound selected fact references or permitted purpose/scope selector
 *   and expected privacy revision; consumed by MemoryService.forget.
 * - MemoryDeletionResponseDto: outbound deletion request reference/generation and current cleanup
 *   progress; produced by forget. Distinguish revoked disclosure eligibility from completed
 *   physical cleanup without echoing deleted fact content.
 *
 * Planned methods:
 * None. Future DTO validation checks selection shape, identifier formats and bounds only.
 *
 * Boundaries/invariants:
 * TrustedCallerContext is separate. Fact identifiers and the expected revision are untrusted
 * lookup/concurrency values; they cannot select another subject or guild. MemoryService loads
 * scoped records, validates authority and maps the response. Owner-internal DeletionProgress
 * remains in ../contracts.ts for lifecycle/recovery coordination; no private entity is exposed.
 */
