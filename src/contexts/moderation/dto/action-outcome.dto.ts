/** Bounded effect progress exposes confirmed references without raw evidence, provider data or credentials. */
import type { ModerationActionState } from '../entities/moderation-action.entity.js';

export interface ModerationActionOutcomeDto {
  readonly actionId: string;
  readonly kind: 'ban' | 'unban' | 'warning' | 'kick';
  readonly state: ModerationActionState;
  readonly unresolved: boolean;
  readonly reasonCode: string | null;
  readonly discordMessageId?: string;
  readonly discordAuditEntryId?: string;
}
export interface ModerationRecoveryResultDto { readonly processed: number; readonly outcomes: readonly ModerationActionOutcomeDto[] }
