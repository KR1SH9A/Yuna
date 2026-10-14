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
 * SourceProvenance: verified guild/channel/message identity, original author when established,
 * source kind, known source revision and source/capture timestamps. Missing attribution/revision
 * remains explicit. This is transport-derived provenance, not a human request or action grant.
 * ExecutionFacts: current permission/hierarchy/target facts with read time and scope.
 * DiscordOperationResult: confirmed response, definitive failure, or unknown outcome; include
 * returned object/request references when available.
 *
 * DTO locations (definitions live there, not duplicated here):
 * dto/normalized-message.dto.ts: NormalizedDiscordMessageDto.
 * dto/interaction-context.dto.ts: InteractionContextDto, derived from trusted transport metadata.
 * dto/normalized-interaction.dto.ts: NormalizedInteractionDto with separate untrusted arguments.
 *
 * Invariants:
 * Snowflake IDs remain strings. Message claims and model text do not establish identity. No SDK
 * instances, ORM entities, or binary media in these boundary values.
 */
