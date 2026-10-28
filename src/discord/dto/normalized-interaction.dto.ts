/** Registered command capabilities and validated discriminated inputs; no tokens or asserted authority. */
import type { DiscordCommandIdentity } from './interaction-context.dto.js';

/** Explicit command choices; broad administration enrollment can only come from owner bootstrap. */
export const discordGrantCapabilities = [
  'guild.pause', 'guild.resume', 'guild.configure', 'community.configure', 'knowledge.manage',
  'moderation.ban', 'moderation.unban', 'moderation.kick',
] as const;

/** Sanitized, immutable command data. Tokens, SDK objects, roles and asserted authority never cross ingress. */
export type NormalizedAdministrationCommand = import('../knowledge-commands.js').NormalizedKnowledgeCommand
  | import('../memory-commands.js').NormalizedMemoryCommand | import('../debate-commands.js').NormalizedDebateCommand | DiscordCommandIdentity & (
  | { readonly command: 'status' | 'bootstrap' | 'configure' | 'usage' | 'limit-clear'; readonly arguments: Readonly<Record<string, never>> }
  | { readonly command: 'action'; readonly arguments: { readonly actionId: string } }
  | { readonly command: 'limit'; readonly arguments: { readonly dailyAttemptLimit?: number; readonly dailyBudget?: { readonly amount: string; readonly currency: string } } }
  | { readonly command: 'remove'; readonly arguments: { readonly expectedInstallationRevision: number } }
  | { readonly command: 'ban'; readonly arguments: { readonly targetUserId: string; readonly reason: string; readonly deleteMessageSeconds: number } }
  | { readonly command: 'unban' | 'kick'; readonly arguments: { readonly targetUserId: string; readonly reason: string } }
  | { readonly command: 'report'; readonly arguments: { readonly channelId: string; readonly messageId: string; readonly allegation: string } }
  | { readonly command: 'grant'; readonly arguments: {
    readonly granteeUserId: string;
    readonly capability: typeof discordGrantCapabilities[number];
    readonly scope: { readonly channelIds: readonly string[]; readonly targetUserIds: readonly string[] };
    readonly sourceOperationKey: string;
    readonly expiresAt: string | null;
  } }
  | { readonly command: 'revoke'; readonly arguments: {
    readonly grantId: string; readonly expectedAuthorityRevision: number;
    readonly expectedRowRevision: number; readonly reasonCode: string;
  } }
  | { readonly command: 'pause'; readonly arguments: { readonly expectedSafetyRevision: number; readonly reasonCode: string } }
  | { readonly command: 'resume'; readonly arguments: { readonly expectedSafetyRevision: number } }
  | { readonly command: 'channel-status'; readonly arguments: { readonly channelId: string } }
  | { readonly command: 'channel'; readonly arguments: {
    readonly channelId: string; readonly mode: 'silent' | 'direct'; readonly expectedRowRevision: number;
  } }
);
