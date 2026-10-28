/** Plain values across the Discord boundary; no SDK objects or provider-selected destinations. */
export interface MessageReference {
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
}

export interface NormalizedConversationMessage extends MessageReference {
  readonly authorId: string;
  readonly text: string;
  readonly previousReply?: string;
  readonly createdAt: Date;
  /** Hash of the full observed source, before removing mentions or trimming input. */
  readonly sourceHash: string;
}

/** Authenticated create-event facts; webhook/system identities never become inferred human targets. */
export interface DiscordOriginalMessageProvenance extends MessageReference {
  readonly eventKind: 'message_create';
  readonly authorKind: 'user' | 'bot' | 'webhook' | 'system' | 'unknown';
  readonly authorUserId: string | null;
  readonly webhookId: string | null;
  readonly messageType: number;
  readonly createdAt: Date | null;
  readonly observedAt: Date;
  readonly shardId?: number;
  readonly gatewaySequence?: number;
}

/** Exact body and attachment metadata from one original dispatch, with explicit access/coverage gaps. */
export interface DiscordOriginalMessageCapture {
  readonly originalContent: string | null;
  readonly attachments: readonly {
    readonly id: string; readonly filename: string; readonly contentType: string | null;
    readonly byteSize: number; readonly description: string | null;
  }[];
  readonly contentAccess: 'available' | 'restricted' | 'missing';
  readonly attachmentsComplete: boolean;
  readonly missingReasons: readonly string[];
}

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

/** Transport-derived identity. Installation identity and permission checks belong to composition/Administration. */
export interface DiscordCommandIdentity {
  readonly actorId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly sourceRequestId: string;
}

/** A full private review may carry one bounded UTF-8 attachment so consent text never needs silent truncation. */
export type DiscordCommandResponse = string | {
  readonly content: string;
  readonly attachment: { readonly filename: string; readonly content: string };
};

/** Explicit command choices; broad administration enrollment can only come from owner bootstrap. */
export const discordGrantCapabilities = [
  'guild.pause', 'guild.resume', 'guild.configure', 'community.configure', 'knowledge.manage',
  'moderation.ban', 'moderation.unban', 'moderation.kick',
] as const;

/** Sanitized, immutable command data. Tokens, SDK objects, roles and asserted authority never cross ingress. */
export type NormalizedAdministrationCommand = import('./knowledge-commands.js').NormalizedKnowledgeCommand
  | import('./memory-commands.js').NormalizedMemoryCommand | import('./debate-commands.js').NormalizedDebateCommand | DiscordCommandIdentity & (
  | { readonly command: 'status' | 'bootstrap' | 'configure' | 'usage' | 'limit-clear'; readonly arguments: Readonly<Record<string, never>> }
  | { readonly command: 'action'; readonly arguments: { readonly actionId: string } }
  | { readonly command: 'limit'; readonly arguments: { readonly dailyAttemptLimit?: number; readonly dailyBudget?: { readonly amount: string; readonly currency: string } } }
  | { readonly command: 'remove'; readonly arguments: { readonly expectedInstallationRevision: number } }
  | { readonly command: 'ban'; readonly arguments: { readonly targetUserId: string; readonly reason: string; readonly deleteMessageSeconds: number } }
  | { readonly command: 'unban'; readonly arguments: { readonly targetUserId: string; readonly reason: string } }
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
