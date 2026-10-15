/**
 * Planned component: DiscordContracts
 * Kind: Trusted source, read and effect contracts
 * Owner: Discord boundary
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Define trusted source, current-read and effect-result values shared with handlers and services.
 * Inbound event DTOs have their own files under dto/ so transport shapes are easy to find.
 *
 * Planned methods:
 * - None. Data contracts and boundary validation schemas only.
 *
 * Planned values:
 * SourceProvenance: verified guild/channel/message identity; event kind; author kind
 * (user/bot/webhook/system/unknown), attributable authorUserId when established and webhookId when
 * present; sentAt, editedAt and capturedAt when known. Preserve Gateway sessionId/shardId/sequence
 * when available and distinguish Gateway MESSAGE_CREATE capture from later update/REST reads.
 * Transport sequence is optional replay provenance within a session, never a global message
 * version. An original-capture reference identifies the actual retained create observation;
 * a message locator, current fetch or reporter statement cannot establish original content.
 * Installation identity is supplied by Administration, not invented by the Discord payload.
 * ExecutionFacts: current permission/hierarchy/target facts with read time and scope.
 * DiscordOperationResult: confirmed response, definitive failure, or unknown outcome; include
 * HTTP status and returned object/request references when available. Successful ban, unban and
 * kick calls return 204 with no action object/ID; returnedExternalId therefore remains nullable.
 * A local correlation/audit-reason reference is not a Discord-returned action ID.
 *
 * DTO locations (definitions live there, not duplicated here):
 * dto/normalized-message.dto.ts: NormalizedDiscordMessageDto.
 * dto/interaction-context.dto.ts: InteractionContextDto, derived from trusted transport metadata.
 * dto/normalized-interaction.dto.ts: NormalizedInteractionDto with separate untrusted arguments.
 *
 * Invariants:
 * Snowflake IDs remain decimal strings, never JavaScript numbers. Preserve absent, null and empty
 * values where their meanings differ. Message claims and model text do not establish identity;
 * a webhook's user-shaped author is not a human account. No SDK instances, ORM entities, or binary
 * media in these boundary values. Display names are snapshots, never identity keys.
 */
