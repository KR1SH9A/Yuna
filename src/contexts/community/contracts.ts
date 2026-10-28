/** Community audience, provenance and destination bindings shared by owners and their durable records. */
export interface AudienceBinding {
  schemaVersion: 1;
  visibility: 'channel' | 'requester';
  channelId: string;
  requesterUserId: string | null;
  revision: number;
}
export interface AllowedMentions { users: string[]; roles: string[]; everyone: false; repliedUser: boolean }
/** Ciphertext only. ISO timestamps keep this bounded continuation compatible with JSONB. */
export interface InteractionContinuation {
  schemaVersion: 1;
  applicationId: string;
  interactionId: string;
  tokenCiphertext: string;
  tokenKeyId: string;
  tokenExpiresAt: string;
  acknowledgment: 'deferred';
  acknowledgedAt: string;
  ephemeral: boolean;
}
export interface ContextBinding { owner: 'intake' | 'knowledge' | 'memory'; recordId: string; revision: number; contentHash: string }

export type ReplyDestination =
  | { transport: 'channel_message'; channelId: string; replyMessageId: string | null; nonce: string; enforceNonce: boolean }
  | { transport: 'interaction_original'; continuation: InteractionContinuation };
