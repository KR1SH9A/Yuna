/**
 * Planned component: DebatesModule
 * Kind: NestJS composition module
 * Owner: Debates
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Register DebateService and DebateScoringPolicy with private DebateSession, ParticipantConsent,
 * TranscriptEntry, TranscriptSnapshot, RubricRevision and DebateEvaluation persistence. Export
 * DebateService.
 *
 * Scope:
 * Staged feature: activate when consented debate mode ships. The dedicated slash-command family
 * and evaluation workflow remain scope-dependent.
 *
 * Planned methods:
 * No business methods planned. This file will describe dependency registration, private entity
 * registration and the narrow exported public services.
 *
 * Collaborators/Boundaries:
 * Consume Administration, Jobs, Usage, Artifacts and narrow Discord contracts. Attributable
 * conduct may go to Moderation public intake; debate scores never flow into discipline.
 *
 * Invariants:
 * Composition must not contain business decisions or conceal dependency cycles with forward
 * references.
 */
