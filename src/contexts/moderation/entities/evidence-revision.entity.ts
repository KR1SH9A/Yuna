/**
 * Planned component: EvidenceRevision
 * Kind: Immutable retained record
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Retain an immutable captured evidence version distinct from derived observations and findings.
 *
 * Planned fields:
 * id; guildId; caseId; revision; sourceKind; sourceIds; originalAuthorId; reporterId when present;
 * capturedText or controlled snapshot reference; contentHash; source/capture timestamps; inspected
 * coverage and gaps; expiresAt.
 *
 * Planned methods:
 * No mutation methods planned. Capture a new record for changed source content; owner-controlled
 * retention may remove retained content when its lifecycle requires deletion.
 *
 * Collaborators/Boundaries:
 * Private context-owned persistence record. The owning service loads and persists it through
 * MikroORM in the caller's transaction. Transition methods operate on supplied values only; they
 * do not query, enqueue, or call external systems.
 *
 * Invariants:
 * An editable Discord URL alone is not an immutable capture. Preserve source author separately
 * from reporter/quoted speaker. Content hash, provenance and coverage describe the exact retained
 * version. Tenant references must remain in one guild through database-enforced constraints.
 * Internal IDs are UUIDs; Discord IDs are strings. Row revision and conditional writes protect
 * mutable transitions; entity checks alone do not replace concurrency constraints.
 */
