/** Bounded knowledge arguments and plain approved views; caller identity and audience verification remain separate. */
import { assertNonNegativeInteger, assertUuid, assertDiscordId, invariant } from '../../../platform/db/entity-values.js';
import type { KnowledgeProvenance, KnowledgeVisibility } from '../entities/knowledge-entry.entity.js';

export interface ApproveKnowledgeEntryDto {
  content: string;
  provenance: { kind: 'staff_submission' | 'document'; sourceReference: string };
  visibility: KnowledgeVisibility;
  predecessor?: { entryId: string; expectedRowRevision: number };
}
export interface ChangeKnowledgeVisibilityDto { entryId: string; expectedRowRevision: number; visibility: KnowledgeVisibility }
export interface RetireKnowledgeEntryDto { entryId: string; expectedRowRevision: number; reasonCode: string }
export interface VisibleKnowledgeQueryDto { search: string; limit?: number; entryIds?: string[] }
export interface KnowledgeEntryDto {
  entryId: string; content: string | null; contentHash: string; rowRevision: number;
  provenance: KnowledgeProvenance | null; visibility: KnowledgeVisibility; approvalActorId: string;
  approvedAt: string; retiredAt: string | null; replacementEntryId: string | null; purgeAfter: string;
}

/** Reject identity/authority fields and copy approved content without normalizing its meaning. */
export function parseApproveKnowledgeEntry(value: unknown): ApproveKnowledgeEntryDto {
  const raw = record(value, ['content', 'provenance', 'visibility', 'predecessor']);
  invariant(typeof raw.content === 'string' && raw.content.trim().length > 0 && raw.content.length <= 6_000, 'Knowledge content must contain 1 to 6000 characters');
  const source = record(raw.provenance, ['kind', 'sourceReference']);
  invariant(source.kind === 'staff_submission' || source.kind === 'document', 'Invalid knowledge provenance kind');
  invariant(typeof source.sourceReference === 'string' && source.sourceReference.trim().length > 0 && source.sourceReference.length <= 512, 'Invalid knowledge source reference');
  const predecessor = raw.predecessor === undefined ? undefined : parseEntryRevision(raw.predecessor);
  return { content: raw.content, provenance: { kind: source.kind, sourceReference: source.sourceReference },
    visibility: parseVisibility(raw.visibility), ...(predecessor ? { predecessor } : {}) };
}

/** A visibility change never silently replaces content or approval identity. */
export function parseChangeKnowledgeVisibility(value: unknown): ChangeKnowledgeVisibilityDto {
  const raw = record(value, ['entryId', 'expectedRowRevision', 'visibility']);
  return { ...parseEntryRevision({ entryId: raw.entryId, expectedRowRevision: raw.expectedRowRevision }), visibility: parseVisibility(raw.visibility) };
}

/** Retirement accepts a reason code, avoiding unbounded free text in audit paths. */
export function parseRetireKnowledgeEntry(value: unknown): RetireKnowledgeEntryDto {
  const raw = record(value, ['entryId', 'expectedRowRevision', 'reasonCode']);
  invariant(typeof raw.reasonCode === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(raw.reasonCode), 'Invalid knowledge retirement reason');
  return { ...parseEntryRevision({ entryId: raw.entryId, expectedRowRevision: raw.expectedRowRevision }), reasonCode: raw.reasonCode };
}

/** Retrieval limits bound both candidate scanning and the number of provider-context entries. */
export function parseVisibleKnowledgeQuery(value: unknown): Required<Pick<VisibleKnowledgeQueryDto, 'search' | 'limit'>> & Pick<VisibleKnowledgeQueryDto, 'entryIds'> {
  const raw = record(value, ['search', 'limit', 'entryIds']);
  invariant(typeof raw.search === 'string' && raw.search.length <= 4_000, 'Invalid knowledge search');
  const limit = raw.limit ?? 5; invariant(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 5, 'Invalid knowledge result limit');
  if (raw.entryIds !== undefined) {
    invariant(Array.isArray(raw.entryIds) && raw.entryIds.length <= 100 && new Set(raw.entryIds).size === raw.entryIds.length, 'Invalid knowledge filter');
    raw.entryIds.forEach(id => assertUuid(id as string));
  }
  return { search: raw.search, limit: limit as number, ...(raw.entryIds === undefined ? {} : { entryIds: [...raw.entryIds as string[]] }) };
}

/** Only explicit guild or exact-channel visibility is supported; thread IDs are never replaced by parent IDs. */
export function parseVisibility(value: unknown): KnowledgeVisibility {
  const raw = record(value, ['schemaVersion', 'kind', 'channelIds']);
  invariant(raw.schemaVersion === 1, 'Unsupported knowledge visibility schema');
  if (raw.kind === 'guild') { invariant(raw.channelIds === undefined, 'Guild visibility does not accept channels'); return { schemaVersion: 1, kind: 'guild' }; }
  invariant(raw.kind === 'channels' && Array.isArray(raw.channelIds) && raw.channelIds.length > 0 && raw.channelIds.length <= 20
    && new Set(raw.channelIds).size === raw.channelIds.length, 'Invalid knowledge channel visibility');
  raw.channelIds.forEach(id => assertDiscordId(id as string));
  return { schemaVersion: 1, kind: 'channels', channelIds: [...raw.channelIds as string[]].sort() };
}

/** Exact revision references prevent a stale approval from editing a newly changed visibility scope. */
function parseEntryRevision(value: unknown): { entryId: string; expectedRowRevision: number } {
  const raw = record(value, ['entryId', 'expectedRowRevision']);
  assertUuid(raw.entryId as string); assertNonNegativeInteger(raw.expectedRowRevision as number, 'expectedRowRevision');
  invariant((raw.expectedRowRevision as number) >= 1, 'Knowledge revision must be positive');
  return { entryId: raw.entryId as string, expectedRowRevision: raw.expectedRowRevision as number };
}

/** Feature DTOs allow no additional trusted-identity or authority-looking properties. */
function record(value: unknown, fields: string[]): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid knowledge arguments');
  invariant(Object.keys(value).every(key => fields.includes(key)), 'Unknown knowledge argument');
  return value as Record<string, unknown>;
}
