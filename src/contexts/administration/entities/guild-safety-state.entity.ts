import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export type SafetyActor = { kind: 'user'; userId: string } | { kind: 'system'; operation: string };
export interface GuildSafetyStateInput extends ScopedEntityInput {
  changedBy: SafetyActor;
  changedAt: Date;
}

/** The service locks this gate while invalidating work bound to an older revision. */
@Entity({ tableName: 'guild_safety_state' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId'] })
@Check({ name: 'guild_safety_state_check_1', expression: '"safety_revision" >= 0' })
@Check({ name: 'guild_safety_state_check_2', expression: '"row_revision" >= 1' })
export class GuildSafetyState extends ScopedEntity {
  @Property({ type: 'boolean' }) paused = false;
  @Property({ type: 'integer' }) safetyRevision = 0;
  @Property({ type: 'text', nullable: true }) reasonCode: string | null = null;
  @Property({ type: 'json' }) changedBy: SafetyActor;
  @Property({ type: Date, columnType: 'timestamptz' }) changedAt: Date;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;

  constructor(input: GuildSafetyStateInput) {
    super(input);
    assertDate(input.changedAt, 'changedAt');
    if (input.changedBy.kind === 'user') assertDiscordId(input.changedBy.userId);
    this.changedBy = copyJson(input.changedBy);
    this.changedAt = new Date(input.changedAt);
    this.updatedAt = new Date(input.changedAt);
  }

  pause(expectedRevision: number, actor: SafetyActor, reasonCode: string | null, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    this.change(true, expectedRevision, actor, reasonCode, at);
  }

  resume(expectedRevision: number, actor: SafetyActor, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    this.change(false, expectedRevision, actor, null, at);
  }

  private change(paused: boolean, expectedRevision: number, actor: SafetyActor, reasonCode: string | null, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    invariant(expectedRevision === this.safetyRevision, 'Stale safety revision');
    assertDate(at, 'at');
    if (actor.kind === 'user') assertDiscordId(actor.userId);
    invariant(reasonCode === null || reasonCode.length <= 128, 'Reason code is too long');
    invariant(this.safetyRevision < 2_147_483_647, 'Safety revision exhausted');
    this.paused = paused;
    this.safetyRevision += 1;
    this.changedBy = copyJson(actor);
    this.reasonCode = reasonCode;
    this.changedAt = new Date(at);
    this.advanceRevision(at);
  }

  private advanceRevision(at: Date): void {
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }
}
