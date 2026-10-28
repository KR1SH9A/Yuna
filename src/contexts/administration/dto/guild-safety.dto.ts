/** Safety command arguments cannot supply identity, permission facts or reusable approval. */
import { assertNonNegativeInteger, invariant } from '../../../platform/db/entity-values.js';

export interface PauseGuildRequestDto { expectedSafetyRevision: number; reasonCode: string }
export interface ResumeGuildRequestDto { expectedSafetyRevision: number }
export interface GuildSafetyResponseDto { paused: boolean; safetyRevision: number; reasonCode: string | null }

/** Validate a bounded pause reason and the exact gate version the requester reviewed. */
export function parsePauseGuildRequest(value: unknown): PauseGuildRequestDto {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid pause request');
  const input = value as Record<string, unknown>;
  invariant(Object.keys(input).every(key => ['expectedSafetyRevision', 'reasonCode'].includes(key)), 'Unknown pause request field');
  assertNonNegativeInteger(input.expectedSafetyRevision as number, 'expectedSafetyRevision');
  invariant(typeof input.reasonCode === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(input.reasonCode), 'Invalid pause reason');
  return { expectedSafetyRevision: input.expectedSafetyRevision as number, reasonCode: input.reasonCode };
}

/** A stale resume cannot cancel a newer independent pause. Governance is not enabled by this DTO. */
export function parseResumeGuildRequest(value: unknown): ResumeGuildRequestDto {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid resume request');
  const input = value as Record<string, unknown>;
  invariant(Object.keys(input).every(key => key === 'expectedSafetyRevision'), 'Unknown resume request field');
  assertNonNegativeInteger(input.expectedSafetyRevision as number, 'expectedSafetyRevision');
  return { expectedSafetyRevision: input.expectedSafetyRevision as number };
}
