/** Provide immutable record identity and installation scope without adding business lifecycle behavior. */
import { randomUUID } from 'node:crypto';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { assertDate, assertDiscordId, assertUuid, type RecordEntityInput, type ScopedEntityInput } from './entity-values.js';

/** Identity only: immutable records do not inherit update APIs or artificial revisions. */
@Entity({ abstract: true })
export abstract class RecordEntity {
  @PrimaryKey({ type: 'uuid' })
  readonly id: string;

  @Property({ type: Date, columnType: 'timestamptz' })
  readonly createdAt: Date;

  /** Create or validate a UUID and copy its creation time as immutable record identity. */
  protected constructor(input: RecordEntityInput = {}) {
    this.id = input.id ?? randomUUID();
    assertUuid(this.id);
    const createdAt = input.createdAt ?? new Date();
    assertDate(createdAt, 'createdAt');
    this.createdAt = new Date(createdAt);
  }
}

/** Scope is an immutable identity; a reinstall gets a different installationId. */
@Entity({ abstract: true })
export abstract class ScopedEntity extends RecordEntity {
  @Property({ type: 'uuid' })
  readonly installationId: string;

  @Property({ type: 'text' })
  readonly guildId: string;

  /** Bind a record to one installation generation and Discord guild before feature fields are assigned. */
  protected constructor(input: ScopedEntityInput) {
    super(input);
    assertUuid(input.installationId);
    assertDiscordId(input.guildId);
    this.installationId = input.installationId;
    this.guildId = input.guildId;
  }
}
