/** Transport-neutral Administration boundaries. Trusted identity comes from ingress, never command arguments. */
export interface TrustedCallerContext {
  readonly actorId: string;
  readonly guildId: string;
  readonly installationId: string;
  readonly sourceRequestId: string;
}

/** Registered application capabilities; none grants native Discord permission or enables a feature. */
export const administrationCapabilities = [
  'administration.manage', 'guild.pause', 'guild.resume', 'guild.configure',
  'community.configure', 'knowledge.manage', 'moderation.ban', 'moderation.unban', 'moderation.kick',
] as const;
export type AdministrationCapability = typeof administrationCapabilities[number];
export interface AuthorityOperation {
  readonly capability: AdministrationCapability;
  readonly channelId?: string;
  readonly targetUserId?: string;
}
export interface CapabilityScope {
  readonly channelIds: readonly string[];
  readonly targetUserIds: readonly string[];
}

/** Fresh adapter observation bound to the actor/request/exact operation; missing facts fail closed. */
export interface CurrentNativeFacts {
  readonly guildId: string;
  readonly actorId: string;
  readonly sourceRequestId: string;
  readonly operation: AuthorityOperation;
  readonly observedAt: Date;
  readonly complete: boolean;
  readonly ownerId: string;
  readonly actorIsMember: boolean;
  readonly actorPermissions: string;
  readonly botPermissions: string;
  readonly target?: {
    readonly userId: string;
    readonly isMember: boolean;
    readonly isGuildOwner: boolean;
    readonly isSelf: boolean;
    readonly actorAboveTarget: boolean;
    readonly botAboveTarget: boolean;
  };
}

/** Performs current Discord reads outside transactions, including hierarchy when needed. */
export interface AdministrationFactReader {
  readFacts(caller: TrustedCallerContext, operation: AuthorityOperation): Promise<CurrentNativeFacts>;
}

/** A snapshot must be checked again inside the effect owner's claim transaction before dispatch. */
export interface StaffRequestAuthority {
  readonly purpose: 'operation' | 'status';
  readonly caller: TrustedCallerContext;
  readonly operation: AuthorityOperation;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly grantRowRevision: number;
  readonly installationGeneration: number;
  readonly installationRevision: number;
  readonly safetyRevision: number;
  readonly observedAt: Date;
}
export type AuthorityEvaluation =
  | { readonly allowed: true; readonly authority: StaffRequestAuthority }
  | { readonly allowed: false; readonly reason: string };
export interface SafetyGate {
  readonly installationId: string;
  readonly guildId: string;
  readonly paused: boolean;
  readonly safetyRevision: number;
  readonly installationActive: boolean;
}

/** Composition routes local invalidation to every enabled owner using the caller's transaction. */
export type AdministrationInvalidation = {
  readonly installationId: string;
  readonly guildId: string;
  readonly safetyRevision: number;
  readonly at: Date;
} & (
  | { readonly kind: 'grant_revoked'; readonly grantId: string; readonly previousGrantRevision: number }
  | { readonly kind: 'guild_paused' | 'guild_resumed' }
);
