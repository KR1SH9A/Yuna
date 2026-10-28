/** Validate explicit staff targets/options separately from authenticated caller identity and current authority. */
import { assertDiscordId, invariant } from '../../../platform/db/entity-values.js';
import type { ModerationActionState } from '../entities/moderation-action.entity.js';

export interface BanRequestDto { readonly targetUserId: string; readonly reason: string; readonly deleteMessageSeconds?: number }
export interface UnbanRequestDto { readonly targetUserId: string; readonly reason: string }
export interface KickRequestDto { readonly targetUserId: string; readonly reason: string }
export interface StaffSanctionResultDto {
  readonly status: 'accepted'; readonly actionId: string; readonly kind: 'ban' | 'unban' | 'kick'; readonly state: ModerationActionState;
}

/** Only bans accept history deletion; identity, authority and unknown options are always rejected. */
export function parseStaffSanction(value: unknown, kind: 'ban' | 'unban' | 'kick'): Required<BanRequestDto> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid sanction request');
  const input = value as Record<string, unknown>;
  const allowed = kind === 'ban' ? ['targetUserId', 'reason', 'deleteMessageSeconds'] : ['targetUserId', 'reason'];
  invariant(Object.keys(input).every(key => allowed.includes(key)), 'Unknown sanction request field');
  assertDiscordId(input.targetUserId as string);
  invariant(typeof input.reason === 'string' && input.reason.trim().length > 0 && input.reason.length <= 350
    && !/[\p{Cc}]/u.test(input.reason), 'Invalid sanction reason');
  const deleteMessageSeconds = input.deleteMessageSeconds ?? 0;
  invariant(Number.isInteger(deleteMessageSeconds) && (deleteMessageSeconds as number) >= 0
    && (deleteMessageSeconds as number) <= 604_800, 'Invalid history deletion window');
  return Object.freeze({ targetUserId: input.targetUserId as string, reason: input.reason, deleteMessageSeconds: deleteMessageSeconds as number });
}
