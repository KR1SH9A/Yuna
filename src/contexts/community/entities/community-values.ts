import { assertDate, assertDiscordId, assertNonNegativeInteger, invariant } from '../../../platform/db/entity-values.js';

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

export function validateAudience(binding: AudienceBinding): void {
  invariant(binding.schemaVersion === 1, 'Unsupported audience schema');
  assertDiscordId(binding.channelId);
  assertNonNegativeInteger(binding.revision, 'audience revision');
  invariant(binding.revision <= 2147483647, 'Audience revision exceeds storage range');
  if (binding.requesterUserId) assertDiscordId(binding.requesterUserId);
  invariant(binding.visibility !== 'requester' || binding.requesterUserId !== null, 'Private audience requires its requester');
}
export function validateMentions(mentions: AllowedMentions): void {
  invariant(mentions.everyone === false, 'Replies cannot mention everyone');
  invariant(mentions.users.length <= 100 && mentions.roles.length <= 100, 'Mention allowlists must be bounded');
  for (const id of [...mentions.users, ...mentions.roles]) assertDiscordId(id);
}
export function validateContinuation(value: InteractionContinuation, at: Date): void {
  invariant(value.schemaVersion === 1 && value.acknowledgment === 'deferred', 'Durable reply requires a deferred interaction');
  assertDiscordId(value.applicationId);
  assertDiscordId(value.interactionId);
  const expiresAt = new Date(value.tokenExpiresAt);
  const acknowledgedAt = new Date(value.acknowledgedAt);
  assertDate(expiresAt, 'tokenExpiresAt');
  assertDate(acknowledgedAt, 'acknowledgedAt');
  invariant(expiresAt > at && acknowledgedAt <= at && expiresAt > acknowledgedAt, 'Interaction continuation is not valid at this time');
  invariant(value.tokenCiphertext.length > 0 && value.tokenCiphertext.length <= 8192 && value.tokenKeyId.length > 0 && value.tokenKeyId.length <= 200, 'Encrypted continuation must be bounded');
}
export function nextRevision(value: number): number {
  assertNonNegativeInteger(value, 'revision');
  invariant(value < 2147483647, 'Revision exhausted its storage range');
  return value + 1;
}
