/**
 * Planned component: DebateSessionDtos
 * Kind: Staged external request and public response DTO catalogue
 * Owner: Debates
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Group the existing proposal, participant consent and cancellation interactions for one session.
 *
 * Scope:
 * Staged until consented debate mode ships; no command family is activated by these shapes.
 *
 * Planned shapes:
 * - ProposeDebateSessionRequestDto: inbound topic, proposed participants, visibility, bounded
 *   limits and rubric reference; consumed by DebateService.proposeSession.
 * - RecordDebateConsentRequestDto: inbound exact session/scope reference and accept/withdraw
 *   choice; consumed by DebateService.recordConsent for the separately authenticated participant.
 * - CancelDebateSessionRequestDto: inbound session reference, bounded cancellation reason and
 *   expected revision; consumed by DebateService.cancelSession for a human cancellation.
 * - DebateSessionResponseDto: outbound session reference, exact proposed/accepted scope,
 *   processing/retention expectations, permitted consent/lifecycle progress and current revision;
 *   produced by the session interaction methods without exposing private transcript content.
 *
 * Planned methods:
 * None. Future DTO validation checks request shapes, identifier formats and bounds only.
 *
 * Boundaries/invariants:
 * Administration's transport-neutral TrustedCallerContext is supplied separately. A proposed
 * participant list is not consent; request fields cannot select the consenting actor or assert
 * native permission, frozen transcript identity or current authority. DebateService loads and
 * validates current scoped records. Trusted consent-driven cancellation remains an internal
 * input path, not a user-controlled cancellation-cause flag.
 */
