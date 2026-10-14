/**
 * Planned component: GrantRevocationDtos
 * Kind: External request and public response DTO catalogue
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the existing grant-revocation interaction without exposing CapabilityGrant records.
 *
 * Planned shapes:
 * - RevokeGrantRequestDto: inbound grant reference, expected authority revision and bounded
 *   revocation reason; consumed by AuthorityService.revokeGrant.
 * - GrantRevocationResponseDto: outbound grant reference, revoked status and resulting authority
 *   revision; produced by AuthorityService.revokeGrant for the requesting interaction.
 *
 * Planned methods:
 * None. Future DTO validation checks request shape, identifier format and bounds only.
 *
 * Boundaries/invariants:
 * TrustedCallerContext is supplied separately from request fields. The caller cannot submit
 * grantor identity, effective guild, permission facts or a preapproved authority decision.
 * AuthorityService loads the scoped grant, verifies current authority and maps the public
 * response. Referencing a grant or knowing its revision does not authorize revocation.
 */
