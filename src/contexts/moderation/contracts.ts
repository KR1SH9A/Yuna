/**
 * Planned component: ModerationContracts
 * Kind: Narrow context bindings and policy values
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Keep domain bindings separate from public use-case DTOs.
 *
 * Planned values:
 * - EvidenceBinding: guildId, immutable installationId, case reference, exact original-capture
 *   evidence revision ID, content hash, coverage and sourceUse=original_evidence;
 *   immutable values, never a retained evidence entity. This binding validates retained original
 *   evidence and authorization, not whether the live message remains current or present.
 * - Disposition: established violation, supported suspicion, allowed or incomplete, with rule
 *   reasons. Technical failure is not supported suspicion.
 *
 * DTO locations:
 * - dto/moderation-intake.dto.ts owns message/report/original-capture completion arguments and
 *   ModerationCaseDto progress.
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
 * Invariants: Original source attribution determines targets. A source edit/deletion alone does
 * not invalidate original_evidence work; current_source bindings belong to consumers that require
 * current text. Missing original capture means incomplete, not an invitation to assess a later
 * snapshot. Webhook/system authors cannot become inferred human sanction targets.
 * DTO structure validation is not identity verification or permission. A worker result cannot
 * replace persisted guild, installation, owner, target or
 * authority. Moderation entities/repositories remain private; there is no generic
 * execute-any-action contract.
 */
