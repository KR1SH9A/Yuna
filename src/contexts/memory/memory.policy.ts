/** Pure private-memory decisions; similarity, text contents and saved authority claims never grant access. */
import type { MemoryFact } from './entities/memory-fact.entity.js';
import type { MemoryScope } from './entities/memory-scope.entity.js';
import { memoryPurpose } from './contracts.js';
export class MemoryPolicy {
  /** A save requires explicit purpose consent and a private subject audience. */
  canStore(scope: MemoryScope): boolean {
    return scope.purposeConsents[memoryPurpose]?.granted === true && scope.allowedAudiences.length === 1
      && scope.allowedAudiences[0]?.kind === 'subject';
  }
  /** An exact current owner may inspect retained private facts; neither cross-user nor public disclosure is supported. */
  canDisclose(scope: MemoryScope, fact: MemoryFact, userId: string, at: Date): boolean {
    return this.canStore(scope) && scope.userId === userId && fact.subjectUserId === userId && fact.scopeId === scope.id
      && fact.installationId === scope.installationId && fact.guildId === scope.guildId && fact.purpose === memoryPurpose
      && fact.audience.kind === 'subject' && fact.consentRevision <= scope.privacyRevision && fact.expiresAt > at;
  }
}
