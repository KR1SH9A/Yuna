import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';
import { nextRevision } from './community-values.js';

export interface ReplyLimits { schemaVersion: 1; maxContextMessages: number; maxContextCharacters: number; deadlineSeconds: number }
export interface KnowledgeScope { schemaVersion: 1; entryIds: string[] }
export interface ChannelReplySettingsInput extends ScopedEntityInput {
  channelId: string;
  mode: 'silent' | 'direct' | 'proactive';
  approvedKnowledgeScope: KnowledgeScope;
  limits: ReplyLimits;
}

/** A thread has its own channel identity and audience; parent-channel access is not inherited here. */
@Check({ name: 'channel_reply_settings_check_1', expression: "mode IN ('silent', 'direct', 'proactive') AND row_revision > 0" })
@Entity({ tableName: 'channel_reply_settings' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'channelId'] })
export class ChannelReplySettings extends ScopedEntity {
  @Property({ type: 'text' }) readonly channelId: string;
  @Property({ type: 'text' }) mode: ChannelReplySettingsInput['mode'];
  @Property({ type: 'json', columnType: 'jsonb' }) approvedKnowledgeScope: KnowledgeScope;
  @Property({ type: 'json', columnType: 'jsonb' }) limits: ReplyLimits;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;

  constructor(input: ChannelReplySettingsInput) {
    super(input);
    assertDiscordId(input.channelId);
    this.validateScope(input.approvedKnowledgeScope);
    this.validateLimits(input.limits);
    invariant(['silent', 'direct', 'proactive'].includes(input.mode), 'Unknown reply mode');
    this.channelId = input.channelId;
    this.mode = input.mode;
    this.approvedKnowledgeScope = copyJson(input.approvedKnowledgeScope);
    this.limits = copyJson(input.limits);
    this.updatedAt = new Date(this.createdAt);
  }

  /** Authorization and invalidation of pending work belong to the caller's transaction. */
  changeMode(mode: ChannelReplySettingsInput['mode'], expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    invariant(['silent', 'direct', 'proactive'].includes(mode), 'Unknown reply mode');
    if (this.mode === mode) return;
    this.mode = mode;
    this.touch(at);
  }

  changeKnowledgeScope(scope: KnowledgeScope, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    this.validateScope(scope);
    this.approvedKnowledgeScope = copyJson(scope);
    this.touch(at);
  }

  changeLimits(limits: ReplyLimits, expectedRowRevision: number, at: Date): void {
    this.check(expectedRowRevision, at);
    this.validateLimits(limits);
    this.limits = copyJson(limits);
    this.touch(at);
  }

  private validateScope(scope: KnowledgeScope): void {
    invariant(scope.schemaVersion === 1 && scope.entryIds.length <= 100, 'Knowledge selection must use a bounded supported schema');
    for (const id of scope.entryIds) assertUuid(id);
    invariant(new Set(scope.entryIds).size === scope.entryIds.length, 'Knowledge selection must not contain duplicates');
  }
  private validateLimits(limits: ReplyLimits): void {
    invariant(limits.schemaVersion === 1, 'Unsupported reply limits schema');
    for (const [label, value] of Object.entries(limits)) assertNonNegativeInteger(value, label);
    invariant(limits.maxContextMessages <= 100 && limits.maxContextCharacters <= 1_000_000 && limits.deadlineSeconds > 0 && limits.deadlineSeconds <= 86400, 'Reply limits exceed bounded workflow limits');
  }
  private check(expected: number, at: Date): void {
    assertDate(at, 'at');
    invariant(this.rowRevision === expected, 'Stale settings revision');
    invariant(at >= this.updatedAt, 'Transition time cannot move backwards');
  }
  private touch(at: Date): void { this.rowRevision = nextRevision(this.rowRevision); this.updatedAt = new Date(at); }
}
