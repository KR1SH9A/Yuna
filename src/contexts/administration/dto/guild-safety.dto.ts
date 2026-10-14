/**
 * Planned component: GuildSafetyDtos
 * Kind: External request and public response DTO catalogue
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the existing pause/resume interactions and their minimal visible safety outcome.
 *
 * Planned shapes:
 * - PauseGuildRequestDto: inbound bounded reason for the independent pause request; consumed by
 *   SafetyService.pauseGuild.
 * - ResumeGuildRequestDto: inbound request to resume the current guild; any exact approval-plan
 *   reference required by configured governance is a lookup value, not proof of approval.
 *   Consumed by SafetyService.resumeGuild.
 * - GuildSafetyResponseDto: outbound paused/resumed state and current safety revision; produced
 *   by pauseGuild or resumeGuild for the requesting interaction.
 *
 * Planned methods:
 * None. Future DTO validation checks request shape, identifier format and bounds only.
 *
 * Boundaries/invariants:
 * The trusted caller, guild and current installation arrive separately as TrustedCallerContext.
 * Current configuration, native facts, authority and any eligible approvals are loaded or
 * verified by the service; request fields cannot assert them. SafetyGate remains the internal
 * transaction/concurrency contract in ../contracts.ts; this response is a display snapshot.
 */
