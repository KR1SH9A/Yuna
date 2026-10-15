/**
 * Planned component: NormalizedDiscordMessageDto
 * Kind: Normalized event DTO
 * Owner: Discord boundary
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Carry a bounded message snapshot from DiscordInputNormalizer to bot intake without SDK objects.
 *
 * Planned fields:
 * Trusted source metadata: SourceProvenance from ../contracts.ts; known eventKind; messageType.
 * Untrusted content: bounded message text and attachment metadata/references.
 * Coverage: contentAccess (available/restricted/unknown), explicitly unavailable fields and
 * attachment capture markers. Attachment metadata includes attachment ID, parent message locator,
 * filename/type/size and temporary signed URL when present; durable capture is a separate fact.
 * Delete events contain message/channel IDs and optional guild ID, not original content/author.
 * Bulk deletes preserve transport identity and normalize one source deletion per message ID.
 *
 * Producer and consumers:
 * normalizeMessage / normalizeMessageRevision -> DiscordHandlers -> durable intake. Bot routing
 * maps the retained snapshot into the owning feature's DTO and separately supplies trusted source
 * values. This transport shape is not a shared business entity or a context-owned request schema.
 *
 * Validation:
 * Check external IDs as decimal strings, known event kinds, timestamp/provenance shape and
 * content/attachment limits. Validate current create/update message payloads; do not assume every
 * update is partial or that SDK cached old state exists. Preserve absent optional data and
 * restricted content rather than converting it into an empty authored message. Validate on receipt
 * and when reading a retained serialized snapshot under its schema version.
 *
 * Planned methods:
 * None. Fields and boundary validation only; no business decisions, queries or networking.
 *
 * Invariants:
 * Source identity comes from verified transport metadata, never message text. Only an authentic
 * MESSAGE_CREATE capture establishes the original body for original-only moderation. Later
 * update/current REST snapshots remain current observations, even when editedAt is null.
 * Missing referenced_message means unknown; explicit null means the referenced message was deleted.
 * Raw attachment URLs expire and do not prove durable capture. Installation identity and permission
 * checks remain with their owners. DTOs do not contain persistent Discord SDK user/member graphs.
 */
