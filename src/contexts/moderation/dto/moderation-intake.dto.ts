/**
 * Planned component: Moderation intake DTOs
 * Kind: Use-case input/output DTO catalogue
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Describe validated message/report/original-capture arguments and filtered intake
 * results. Trusted caller and original source identity are separate service inputs.
 *
 * Scope: Existing text use cases only; no additional product operations are introduced.
 *
 * Planned DTOs and fields:
 * - IngestMessageDto (input): Content text, bounded attachment references and explicit
 *   completeness/coverage gaps from the original MESSAGE_CREATE capture. Guild, installationId,
 *   author kind/identity and original capture reference arrive separately as trusted values.
 * - ReportMessageDto (input): Reported source reference and bounded report reason. No accused-user
 *   identity or moderation disposition chosen by the reporter.
 * - CompleteOriginalCaptureDto (internal input): Case reference, expected case/evidence revision,
 *   original capture reference, additional original artifact references/coverage and capture
 *   correction reason if needed. Trusted original-event/artifact provenance arrives separately.
 *   This is not an end-user edit command and cannot carry later message text as a replacement.
 * - ModerationCaseDto (output): Case reference, workflow phase, optional accepted Disposition/rule
 *   reasons, current EvidenceBinding when caller access permits, resulting task/action references
 *   and minimal progress or rejection reason. No raw retained evidence or live entity.
 *
 * Runtime validation: Validate identifier/reference formats, bounded lengths/counts, required
 * capture combinations, revision shape and allowed coverage labels at ingress. Resolve reported
 * sources and validate same-guild ownership/access inside Moderation; DTO validation does not
 * prove author identity, authentic original capture or permission. Missing original capture stays
 * incomplete; report/current REST content cannot fill the gap. Return only fields authorized for the
 * receiving audience.
 *
 * Planned methods: No business methods or queries planned. These comments describe plain
 * input/output data; validation implementation and its library are not chosen.
 *
 * Receiving/returning services: ModerationService receives these argument values alongside
 * verified caller/source values. Trusted completion handlers use Jobs StoredResultReference, not a
 * user-supplied provider result, and receive small internal continuation outcomes rather than a
 * human-facing case projection. Original-capture completion is restricted to trusted internal work.
 *
 * Collaborators/Boundaries: EvidenceBinding and Disposition remain defined in ../contracts.ts.
 * Ingress projects verified Discord metadata into separate trusted values; do not bind
 * actor/guild/authority from these argument DTOs. A report is an allegation and cannot select a
 * sanction target.
 *
 * Trusted caller contract: User-invoked operations receive Administration TrustedCallerContext
 * separately from the feature DTO. It records verified provenance, not permission. System
 * completion/recovery calls instead use stored owner-bound references and trusted scheduling
 * scope. No parallel per-feature caller shape is defined.
 */
