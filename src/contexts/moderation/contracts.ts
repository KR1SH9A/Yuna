/**
 * Planned component: ModerationContracts
 * Kind: Plain boundary contract catalogue
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the public serialized data boundary. Planned plain boundary types:
 * ModerationInput: trusted guild/source/author identity, untrusted content, source revision and
 * coverage.
 * ReportCommand: authenticated reporter plus source reference; reporter and accused subject remain
 * distinct.
 * EvidenceBinding: case, exact captured revision, hash and coverage.
 * Disposition: established violation, supported suspicion, allowed or incomplete, with
 * rule reasons.
 * StaffSanctionCommand: exact authenticated operation, target, source and supplied authority
 * binding.
 * CaseView: access-filtered serialized status, findings and actual effect outcomes.
 * ActionOutcome: lifecycle, operation result, attribution evidence and unresolved status.
 *
 * Scope:
 * Explicit kicks are optional. No strike/recurrence contract is implied by the immediate-ban
 * baseline.
 *
 * Planned methods:
 * No business methods planned. These are conceptual data shapes, not runtime services,
 * declarations or implementations.
 *
 * Collaborators/Boundaries:
 * Public inputs for intake and exact staff sanctions; serialized results
 * for handlers. AI task schemas stay in the AI contracts boundary.
 *
 * Invariants:
 * Source attribution determines targets. Supported suspicion and technical failure are different
 * outcomes. No worker-supplied IDs can replace the persisted guild, owner, target or authority. No
 * generic execute-any-action contract.
 */
