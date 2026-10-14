/**
 * Planned component: NormalizedInteractionDto
 * Kind: Normalized interaction envelope DTO
 * Owner: Discord boundary
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe a verified interaction before a known feature operation parses its arguments.
 *
 * Planned fields:
 * context: InteractionContextDto; known interaction/command identifier; bounded untrusted option
 * values. A command identifier is resolved through explicit bot wiring, never dynamic invocation.
 *
 * Producer and consumers:
 * DiscordInputNormalizer.normalizeInteraction -> DiscordHandlers.onInteraction -> the selected
 * feature-owned request DTO. The feature DTO owns its operation-specific validation rules.
 *
 * Validation:
 * Validate the envelope and supported command before dispatch; parse only allowlisted argument
 * fields. Reject unexpected privileged fields. Perform actual runtime validation in the Discord
 * handler path; TypeScript annotations or a DTO filename alone do not validate an event.
 *
 * Planned methods:
 * None. Plain values and validation specification only.
 *
 * Invariants:
 * Acknowledgment/defer belongs to transport handling. Services decide authorization and business
 * eligibility. Do not carry SDK interactions, ORM entities, bot tokens or provider clients.
 */
