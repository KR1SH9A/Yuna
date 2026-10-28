/** Store immutable control and execution audit envelopes containing references rather than private payloads. */
import { Entity, Index, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../db/base.entity.js';
import { assertDate, assertDiscordId, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../db/entity-values.js';

export type AuditOrigin = { kind: 'user'; userId: string } | { kind: 'policy'; policyRevisionId: string } | { kind: 'system'; component: string };
export interface AuditReference { owner: string; recordId: string; revision: number | null }
export interface AuditEntryInput extends ScopedEntityInput {
  occurredAt: Date;
  origin: AuditOrigin;
  operation: string;
  references: AuditReference[];
  outcome: 'intent' | 'succeeded' | 'failed' | 'unknown' | 'canceled' | 'discarded';
  correlationId: string;
  idempotencyKey: string;
  purgeAfter: Date;
}

/** Append-only transition metadata. Original message content belongs to EvidenceRevision. */
@Entity({ tableName: 'audit_entry' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'idempotencyKey'] })
@Index({ properties: ['installationId', 'correlationId', 'occurredAt'] })
@Index({ properties: ['purgeAfter'] })
export class AuditEntry extends ScopedEntity {
  @Property({ type: 'integer' }) readonly schemaVersion = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly occurredAt: Date;
  @Property({ type: 'json' }) readonly origin: AuditOrigin;
  @Property({ type: 'text' }) readonly operation: string;
  @Property({ type: 'json' }) readonly references: AuditReference[];
  @Property({ type: 'text' }) readonly outcome: AuditEntryInput['outcome'];
  @Property({ type: 'text' }) readonly correlationId: string;
  @Property({ type: 'text' }) readonly idempotencyKey: string;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;

  /** Validate immutable audit identity, origin, outcome and bounded references before persistence. */
  constructor(input: AuditEntryInput) {
    super(input);
    assertDate(input.occurredAt, 'occurredAt');
    assertDate(input.purgeAfter, 'purgeAfter');
    invariant(input.purgeAfter > input.occurredAt, 'Invalid audit retention');
    invariant(input.operation.length > 0 && input.correlationId.length > 0 && input.idempotencyKey.length > 0, 'Audit operation identity is required');
    if (input.origin.kind === 'user') assertDiscordId(input.origin.userId);
    else if (input.origin.kind === 'policy') assertUuid(input.origin.policyRevisionId);
    else invariant(input.origin.component.length > 0, 'System origin is required');
    for (const ref of input.references) {
      assertUuid(ref.recordId);
      invariant(ref.owner.length > 0 && (ref.revision === null || Number.isSafeInteger(ref.revision) && ref.revision >= 0), 'Invalid audit reference');
    }
    this.occurredAt = new Date(input.occurredAt);
    this.origin = copyJson(input.origin);
    this.operation = input.operation;
    this.references = copyJson(input.references);
    this.outcome = input.outcome;
    this.correlationId = input.correlationId;
    this.idempotencyKey = input.idempotencyKey;
    this.purgeAfter = new Date(input.purgeAfter);
  }
}
