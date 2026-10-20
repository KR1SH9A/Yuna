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
