/** Append bounded Debate transition references in their owner transaction without copying private text or scores. */
import type { EntityManager } from '@mikro-orm/postgresql';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import type { AuditEntryInput, AuditOrigin, AuditReference } from '../../platform/audit/entities/audit-entry.entity.js';
import type { GuildLifecycleService, InstallationScope } from '../administration/guild-lifecycle.service.js';

export class DebateAudit {
  /** Resolve the approved metadata lifetime through the same installation lock already held by the owner. */
  constructor(private readonly scope: InstallationScope, private readonly lifecycle: GuildLifecycleService,
    private readonly recorder = new AuditRecorder()) {}

  /** A durable owner record/revision identifies one transition; replaying an unchanged state adds no new record. */
  async record(em: EntityManager, input: { operation: string; outcome: AuditEntryInput['outcome']; sessionId: string;
    recordId: string; revision: number; at: Date; owner?: 'debates' | 'jobs'; origin?: AuditOrigin; references?: AuditReference[] }): Promise<void> {
    const config = await this.lifecycle.readPolicyConfig(em, this.scope);
    await this.recorder.recordTransition(em, { ...this.scope, createdAt: input.at, occurredAt: input.at,
      origin: input.origin ?? { kind: 'system', component: 'debates.owner' }, operation: input.operation, outcome: input.outcome,
      correlationId: input.sessionId, idempotencyKey: `${input.operation}:${input.recordId}:${input.revision}`,
      references: [{ owner: input.owner ?? 'debates', recordId: input.recordId, revision: input.revision }, ...(input.references ?? [])],
      purgeAfter: new Date(input.at.getTime() + config.retention.metadataDays * 86400_000) });
  }
}
