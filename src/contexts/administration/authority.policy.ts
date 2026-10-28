/** Pure application/native authorization rules. SDK reads, storage and optional governance stay outside this policy. */
import type { AuthorityOperation, CurrentNativeFacts, TrustedCallerContext } from './contracts.js';

/** Discord permission values remain BigInt; administrator permission never bypasses target hierarchy. */
export class AuthorityPolicy {
  /** Check exact bindings and native permission; read-only status does not require the target to remain sanctionable. */
  canExecute(caller: TrustedCallerContext, operation: AuthorityOperation, facts: CurrentNativeFacts, now: Date,
    purpose: 'operation' | 'status' = 'operation'): string | null {
    if (facts.complete !== true || facts.guildId !== caller.guildId || facts.actorId !== caller.actorId || facts.sourceRequestId !== caller.sourceRequestId
      || facts.operation.capability !== operation.capability || facts.operation.channelId !== operation.channelId
      || facts.operation.targetUserId !== operation.targetUserId) return 'native_facts_mismatch';
    if (!(facts.observedAt instanceof Date) || !Number.isFinite(facts.observedAt.getTime())
      || facts.observedAt > now || now.getTime() - facts.observedAt.getTime() > 5000) return 'native_facts_stale';
    if (facts.actorIsMember !== true || !/^[0-9]{1,40}$/.test(facts.actorPermissions) || !/^[0-9]{1,40}$/.test(facts.botPermissions)) return 'native_facts_incomplete';
    const actor = BigInt(facts.actorPermissions), bot = BigInt(facts.botPermissions);
    const owner = caller.actorId === facts.ownerId;
    const administrator = owner || (actor & 8n) !== 0n;
    if (operation.capability === 'administration.manage') return owner ? null : 'current_owner_required';
    if (!operation.capability.startsWith('moderation.')) return administrator ? null : 'native_administrator_required';
    if (!operation.targetUserId || !facts.target || facts.target.userId !== operation.targetUserId) return 'target_facts_missing';
    const permission = operation.capability === 'moderation.kick' ? 2n : 4n;
    if ((!administrator && (actor & permission) === 0n) || ((bot & 8n) === 0n && (bot & permission) === 0n)) return 'native_permission_denied';
    if (operation.capability === 'moderation.unban') return administrator ? null : 'native_administrator_required';
    // A completed kick removes membership. Status-only authority cannot be reused to authorize an effect.
    if (purpose === 'status') return null;
    if (facts.target.isGuildOwner || facts.target.isSelf || operation.targetUserId === caller.actorId) return 'target_protected';
    if (operation.capability === 'moderation.kick' && !facts.target.isMember) return 'target_not_member';
    if (facts.target.isMember && (!facts.target.botAboveTarget || (!owner && !facts.target.actorAboveTarget))) return 'target_hierarchy_denied';
    return null;
  }
}
