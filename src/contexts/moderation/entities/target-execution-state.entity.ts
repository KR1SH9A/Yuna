/** Serialize conflicting moderation effects for one account across cases and installation generations. */
import { nextCounter } from './moderation-values.js';
import { Check, Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { assertDate, assertDiscordId, assertNonNegativeInteger, assertUuid, invariant } from '../../../platform/db/entity-values.js';

export interface TargetExecutionStateInput { guildId: string; targetUserId: string; createdAt?: Date }

/** This account gate deliberately spans installations; reinstall must not hide an uncertain ban. */
@Check({ name: 'target_execution_state_check_1', expression: "(unresolved_action_id IS NULL) = (unresolved_installation_id IS NULL)" })
@Check({ name: 'target_execution_state_check_2', expression: "generation >= 0 AND row_revision > 0" })
@Entity({ tableName: 'target_execution_state' })
export class TargetExecutionState {
  @PrimaryKey({ type: 'text' }) readonly guildId: string;
  @PrimaryKey({ type: 'text' }) readonly targetUserId: string;
  @Property({ type: 'integer' }) generation = 0;
  @Property({ type: 'uuid', nullable: true }) unresolvedActionId: string | null = null;
  @Property({ type: 'uuid', nullable: true }) unresolvedInstallationId: string | null = null;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;

  /** Create an unclaimed target gate with a valid guild/account identity and starting timestamp. */
  constructor(input: TargetExecutionStateInput) {
    assertDiscordId(input.guildId);
    assertDiscordId(input.targetUserId);
    const at = input.createdAt ?? new Date();
    assertDate(at, 'createdAt');
    this.guildId = input.guildId;
    this.targetUserId = input.targetUserId;
    this.updatedAt = new Date(at);
  }

  /** Claim an empty target gate for exactly one durable action and advance its execution fence. */
  claim(actionId: string, installationId: string, expectedGeneration: number, at: Date): number {
    assertUuid(actionId);
    assertUuid(installationId);
    this.check(expectedGeneration, at);
    invariant(this.unresolvedActionId === null, 'The target has an unresolved action');
    this.unresolvedActionId = actionId;
    this.unresolvedInstallationId = installationId;
    this.generation = nextCounter(this.generation);
    this.touch(at);
    return this.generation;
  }

  /** Keep ownership after an ambiguous outcome so a later ban or reversal cannot race it. */
  retainUnresolved(actionId: string, expectedGeneration: number, at: Date): void {
    this.check(expectedGeneration, at);
    invariant(this.unresolvedActionId === actionId, 'The unresolved action does not own this target');
    this.touch(at);
  }

  /** The caller supplies established resolution, never merely an expired lease or current ban state. */
  releaseResolved(actionId: string, expectedGeneration: number, resolution: 'confirmed' | 'definitively_not_applied', at: Date): void {
    this.check(expectedGeneration, at);
    invariant(this.unresolvedActionId === actionId, 'The resolving action does not own this target');
    invariant(resolution === 'confirmed' || resolution === 'definitively_not_applied', 'Resolution must be established');
    this.unresolvedActionId = null;
    this.unresolvedInstallationId = null;
    this.generation = nextCounter(this.generation);
    this.touch(at);
  }

  /** Validate the caller's target generation and prevent transition time from moving backward. */
  private check(expectedGeneration: number, at: Date): void {
    assertNonNegativeInteger(expectedGeneration, 'expectedGeneration');
    assertDate(at, 'at');
    invariant(this.generation === expectedGeneration, 'Stale target generation');
    invariant(at >= this.updatedAt, 'Transition time cannot move backwards');
  }
  /** Advance the row revision and timestamp after a validated target-state change. */
  private touch(at: Date): void { this.rowRevision = nextCounter(this.rowRevision); this.updatedAt = new Date(at); }
}
