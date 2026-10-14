/**
 * Planned component: ModerationContracts
 * Kind: Narrow context bindings and policy values
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Keep domain bindings separate from public use-case DTOs.
 *
 * Planned values:
 * - EvidenceBinding: case reference, exact retained revision, content hash and source coverage;
 *   immutable values, never a retained evidence entity.
 * - Disposition: established violation, supported suspicion, allowed or incomplete, with rule
 *   reasons. Technical failure is not supported suspicion.
 *
 * DTO locations:
 * - dto/moderation-intake.dto.ts owns message/report/revision arguments and ModerationCaseDto
 *   progress.
 * - dto/staff-sanction.dto.ts owns exact staff ban/kick/unban arguments and
 *   StaffSanctionResultDto.
 * - dto/action-outcome.dto.ts owns serialized effect outcomes and bounded recovery summaries.
 *
 * Trusted and infrastructure values: Reuse TrustedCallerContext, StaffRequestAuthority and
 * PolicyAuthority from Administration contracts; do not redefine identity or authority here. Bot
 * ingress maps verified transport metadata to TrustedCallerContext separately from validated
 * feature arguments. SourceProvenance and DiscordOperationResult remain plain Discord
 * boundary contracts. Internal AI continuations reuse Jobs StoredResultReference/acceptance
 * bindings and AI task schemas.
 *
 * Scope: Explicit kicks remain optional. No strike/recurrence contract is implied by the
 * immediate-ban baseline.
 *
 * Planned methods: No business methods planned. These are plain context values and references to
 * the owning DTO catalogues; validation/query behavior belongs at its stated boundary.
 *
 * Collaborators/Boundaries: Services consume plain caller/source values and feature DTOs, never
 * bot app types, Discord SDK objects, another context's ORM entities or provider clients. Public
 * DTO definitions live only in dto files; no mirrored request/response definitions remain here.
 *
 * Invariants: Source attribution determines targets. DTO structure validation is not identity
 * verification or permission. A worker result cannot replace persisted guild, owner, target or
 * authority. Moderation entities/repositories remain private; there is no generic
 * execute-any-action contract.
 */
