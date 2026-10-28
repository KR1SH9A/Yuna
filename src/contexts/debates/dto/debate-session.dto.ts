/** Validate bounded Debate arguments without accepting caller identity or provider results. */
import { assertDiscordId, assertUuid, copyJson, invariant } from '../../../platform/db/entity-values.js';
import type { DebateRubricInput } from '../contracts.js';
import type { DebateState } from '../entities/debate-session.entity.js';

export interface ProposeDebateSessionRequestDto {
  readonly channelId: string; readonly opponentUserId: string; readonly topic: string;
  readonly retentionSeconds: number; readonly rubric: DebateRubricInput;
}
export interface DebateSessionResponseDto {
  readonly sessionId: string; readonly state: DebateState; readonly revision: number; readonly scopeHash: string;
  readonly channelId: string; readonly participantIds: readonly string[]; readonly topic: string | null;
  readonly rubric: DebateRubricInput | null; readonly consentedUserIds: readonly string[]; readonly assessmentModel: string;
  readonly transcriptId: string | null; readonly evaluationId: string | null; readonly purgeAfter: string;
  readonly retentionSeconds: number; readonly payerUserId: string;
  readonly processing: 'explicit_submissions_jev_scoring';
}

/** Copy a plain object and reject unknown arguments before any owner read or mutation. */
export function debateArguments(value: unknown, keys: readonly string[]): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid Debate arguments');
  const input = copyJson(value) as Record<string, unknown>;
  invariant(Object.keys(input).every(key => keys.includes(key)), 'Unknown Debate argument'); return input;
}

/** Six fractional places let deterministic owner arithmetic use exact integer units. */
export function rubricDecimal(value: unknown): string {
  invariant(typeof value === 'string' && /^(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?$/.test(value), 'Invalid rubric decimal'); return value;
}

/** Freeze up to five criteria with visible ordered score descriptions. */
export function parseDebateRubric(value: unknown): DebateRubricInput {
  const input = debateArguments(value, ['criteria', 'minimumWinningMargin', 'minimumConfidence', 'paired', 'maximumPairDifference']);
  invariant(Array.isArray(input.criteria) && input.criteria.length >= 1 && input.criteria.length <= 5, 'Debate requires one to five criteria');
  const seen = new Set<string>();
  const criteria = input.criteria.map(value => {
    const row = debateArguments(value, ['id', 'description', 'levels', 'weight']);
    invariant(typeof row.id === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(row.id) && !seen.has(row.id), 'Invalid criterion identity'); seen.add(row.id);
    invariant(typeof row.description === 'string' && row.description.length >= 1 && row.description.length <= 500, 'Invalid criterion description');
    invariant(Array.isArray(row.levels) && row.levels.length >= 2 && row.levels.length <= 6
      && row.levels.every(level => typeof level === 'string' && level.length >= 1 && level.length <= 200), 'Invalid criterion levels');
    return { id: row.id, description: row.description, levels: row.levels as string[], weight: rubricDecimal(row.weight) };
  });
  invariant(criteria.some(value => /[1-9]/.test(value.weight)), 'At least one criterion must carry weight');
  invariant(typeof input.minimumConfidence === 'number' && Number.isFinite(input.minimumConfidence)
    && input.minimumConfidence > 0.5 && input.minimumConfidence <= 1, 'Invalid scoring confidence');
  invariant(typeof input.paired === 'boolean' && Number.isInteger(input.maximumPairDifference)
    && (input.maximumPairDifference as number) >= 0 && (input.maximumPairDifference as number) <= 5, 'Invalid paired comparison');
  return { criteria, minimumWinningMargin: rubricDecimal(input.minimumWinningMargin), minimumConfidence: input.minimumConfidence,
    paired: input.paired, maximumPairDifference: input.maximumPairDifference as number };
}

/** Proposal fixes participants, audience and retention before anyone consents. */
export function parseDebateProposal(value: unknown): ProposeDebateSessionRequestDto {
  const input = debateArguments(value, ['channelId', 'opponentUserId', 'topic', 'retentionSeconds', 'rubric']);
  assertDiscordId(input.channelId as string); assertDiscordId(input.opponentUserId as string);
  invariant(typeof input.topic === 'string' && input.topic.trim().length >= 1 && input.topic.length <= 500, 'Invalid Debate topic');
  invariant(Number.isInteger(input.retentionSeconds) && (input.retentionSeconds as number) >= 300
    && (input.retentionSeconds as number) <= 604800, 'Invalid Debate retention');
  return { channelId: input.channelId as string, opponentUserId: input.opponentUserId as string, topic: input.topic,
    retentionSeconds: input.retentionSeconds as number, rubric: parseDebateRubric(input.rubric) };
}

/** Every action names a scoped UUID; its use case validates the extra fields. */
export function parseDebateAction(value: unknown, extra: readonly string[] = []): Record<string, unknown> & { sessionId: string } {
  const input = debateArguments(value, ['sessionId', ...extra]); assertUuid(input.sessionId as string); return input as Record<string, unknown> & { sessionId: string };
}
