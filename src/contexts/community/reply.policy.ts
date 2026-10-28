/** Pure checks for the released text reply flow; owners supply current source, settings and disclosure bindings. */
import type { AllowedMentions, AudienceBinding } from './contracts.js';
import { validateAudience as validateBinding } from './entities/community-values.js';

/** Ingress establishes human addressing; these checks never grant authority or discover private context. */
export class ReplyPolicy {
  /** Admit bounded, recent explicit input only in direct mode; unsupported proactive mode stays closed. */
  static shouldConsiderReply(input: { guildId: string; text: string; previousReply?: string; createdAt: Date },
    guildId: string, mode: 'silent' | 'direct' | 'proactive', now: Date): boolean {
    const created = input.createdAt.getTime(), at = now.getTime();
    return mode === 'direct' && input.guildId === guildId && Number.isFinite(created) && Number.isFinite(at)
      && created <= at + 30_000 && Math.min(created, at) + 120_000 > at
      && typeof input.text === 'string' && input.text.trim().length > 0 && input.text.length <= 4_000
      && (input.previousReply === undefined || (typeof input.previousReply === 'string' && input.previousReply.length <= 2_000));
  }

  /** A public reply requires its exact channel and unchanged requester/visibility/revision; private bindings cannot be widened. */
  static validateAudience(binding: AudienceBinding, channelId: string, expected?: AudienceBinding): boolean {
    try {
      validateBinding(binding);
      if (binding.visibility !== 'channel' || binding.channelId !== channelId) return false;
      if (!expected) return true;
      validateBinding(expected);
      return expected.visibility === binding.visibility && expected.channelId === binding.channelId
        && expected.requesterUserId === binding.requesterUserId && expected.revision === binding.revision;
    } catch { return false; }
  }

  /** Generated replies must fit one nonempty message and cannot enable any mentions at dispatch. */
  static validateReply(text: unknown, mentions?: AllowedMentions | null): text is string {
    return typeof text === 'string' && text.trim().length > 0 && text.length <= 2_000
      && (mentions === undefined || (mentions !== null && mentions.everyone === false && mentions.repliedUser === false
        && Array.isArray(mentions.users) && mentions.users.length === 0 && Array.isArray(mentions.roles) && mentions.roles.length === 0));
  }
}
