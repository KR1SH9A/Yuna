/** Plain message identities, current conversation input and original-event provenance across Discord ingress. */
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
