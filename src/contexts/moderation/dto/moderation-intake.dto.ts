/**
 * Planned component: Moderation intake DTOs
 * Kind: Use-case input/output DTO catalogue
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility: Describe validated message/report/revision arguments and access-filtered intake
 * results. Trusted caller and original source identity are separate service inputs.
 *
 * Scope: Existing text use cases only; no additional product operations are introduced.
 *
 * Planned DTOs and fields:
 * - IngestMessageDto (input): Content text, bounded attachment references and explicit
 *   completeness/coverage gaps from the normalized capture. Guild, author, source identity and
 *   authoritative source revision arrive separately as trusted source values.
 * - ReportMessageDto (input): Reported source reference and bounded report reason. No accused-user
 *   identity or moderation disposition chosen by the reporter.
 * - ReviseEvidenceDto (input): Case reference, expected case/evidence revision and replacement
 *   capture values (text or controlled snapshot reference, attachments and coverage gaps). Trusted
 *   updated source attribution remains separate.
 * - ModerationCaseDto (output): Case reference, workflow phase, optional accepted Disposition/rule
 *   reasons, current EvidenceBinding when caller access permits, resulting task/action references
 *   and minimal progress or rejection reason. No raw retained evidence or live entity.
 *
 * Runtime validation: Validate identifier/reference formats, bounded lengths/counts, required
 * capture combinations, revision shape and allowed coverage labels at ingress. Resolve reported
 * sources and validate same-guild ownership/access inside Moderation; DTO validation does not
 * prove author identity, evidence truth or permission. Return only fields authorized for the
 * receiving audience.
 *
 * Planned methods: No business methods or queries planned. These comments describe plain
 * input/output data; validation implementation and its library are not chosen.
 *
 * Receiving/returning services: ModerationService receives these argument values alongside
 * verified caller/source values. Trusted completion handlers use Jobs StoredResultReference, not a
 * user-supplied provider result, and receive the same serialized progress view.
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
