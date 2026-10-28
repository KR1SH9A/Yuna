/** Plain values across the Discord boundary; no SDK objects or provider-selected destinations. */
import type { MessageReference } from './dto/normalized-message.dto.js';
export type { MessageReference, NormalizedConversationMessage, DiscordOriginalMessageProvenance, DiscordOriginalMessageCapture } from './dto/normalized-message.dto.js';

export type DiscordSendResult =
  | { readonly classification: 'delivered'; readonly messageId: string }
  | { readonly classification: 'definitive_failure' | 'unknown'; readonly code: string; readonly httpStatus?: number };

export interface DiscordSourceState {
  readonly exists: boolean;
  readonly sourceHash: string | null;
  readonly canSend: boolean;
}

export interface DiscordReplyRequest extends MessageReference {
  readonly content: string;
  readonly nonce: string;
  readonly deadline: Date;
  readonly expectedSourceHash?: string;
}

export interface DiscordReplyLookup extends MessageReference {
  readonly contentHash: string;
  readonly nonce: string;
}

import type { DiscordCommandIdentity } from './dto/interaction-context.dto.js';
export type { DiscordCommandIdentity, DiscordCommandResponse } from './dto/interaction-context.dto.js';

export { discordGrantCapabilities } from './dto/normalized-interaction.dto.js';
export type { NormalizedAdministrationCommand } from './dto/normalized-interaction.dto.js';

/** Native operations are structural so Discord does not import a business context. */
export interface DiscordAuthorityOperation {
  readonly capability: string;
  readonly channelId?: string;
  readonly targetUserId?: string;
}
export type DiscordAuthorityCaller = Pick<DiscordCommandIdentity, 'actorId' | 'guildId' | 'sourceRequestId'>;

/** Fresh guild-wide permission/hierarchy facts, preserving the caller's exact typed operation. */
export interface DiscordNativeAuthorityFacts<Operation extends DiscordAuthorityOperation = DiscordAuthorityOperation> {
  readonly guildId: string;
  readonly actorId: string;
  readonly sourceRequestId: string;
  readonly operation: {
    readonly capability: Operation['capability']; readonly channelId?: string; readonly targetUserId?: string;
  };
  readonly observedAt: Date;
  readonly complete: boolean;
  readonly ownerId: string;
  readonly actorIsMember: boolean;
  readonly actorPermissions: string;
  readonly botPermissions: string;
  readonly target?: {
    readonly userId: string; readonly isMember: boolean; readonly isGuildOwner: boolean;
    readonly isSelf: boolean; readonly actorAboveTarget: boolean; readonly botAboveTarget: boolean;
  };
}
