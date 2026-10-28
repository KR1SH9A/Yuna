/** Register and acknowledge Debate tasks in their owner's transaction; workers receive only reviewed SQL entry points. */
import { createHash, randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { InstallationScope } from '../../contexts/administration/guild-lifecycle.service.js';
import { copyJson, invariant, type JsonObject } from '../db/entity-values.js';
import { AiTask } from './entities/ai-task.entity.js';
import { PreparedInput } from './entities/prepared-input.entity.js';
import { TaskResult } from './entities/task-result.entity.js';
import { TaskAcceptance } from './entities/task-acceptance.entity.js';
import { OutboxEntry } from './entities/outbox-entry.entity.js';
import type { DebateCompletionReference, DebatePreparedPayload } from './debate-task.contracts.js';
import { UsageService } from '../usage/usage.service.js';

export interface DebateTaskRegistration extends InstallationScope {
  sessionId: string; variant: 'original' | 'reversed'; snapshotId: string; rubricId: string; cancellationGeneration: number;
  scopeRevision: number; safetyRevision: number; model: string; payload: DebatePreparedPayload; now: Date; deadline: Date; purgeAfter: Date;
  consentScopeHash: string;
}
export interface StoredDebateCompletion extends DebateCompletionReference {
  variant: 'original' | 'reversed'; snapshotId: string; rubricId: string; cancellationGeneration: number;
  scopeRevision: number; safetyRevision: number; model: string; outcome: TaskResult['outcome'];
  payload: JsonObject | null; acknowledged: boolean; currentAttempt: boolean; deadline: Date;
}

export class DebateTaskService {
  /** Reuse the accounting owner's deletion policy rather than bypass unresolved usage liabilities. */
  constructor(private readonly usage = new UsageService()) {}
  /** Register exactly one attempt for one immutable frozen transcript/rubric/order binding. */
  register(em: EntityManager, input: DebateTaskRegistration): string {
    invariant(em.isInTransaction(), 'Debate registration requires owner transaction');
    invariant(input.deadline > input.now && input.deadline.getTime() <= input.now.getTime() + 120000 && input.deadline <= input.purgeAfter, 'Invalid Debate deadline');
    const payload = copyJson(input.payload) as unknown as JsonObject;
    invariant(Buffer.byteLength(JSON.stringify(payload)) <= 32768, 'Debate input exceeds boundary');
    const taskId = randomUUID(), inputId = randomUUID(), scope = { installationId: input.installationId, guildId: input.guildId, createdAt: input.now };
    const validityBindings = { transcriptSnapshotId: input.snapshotId, rubricRevisionId: input.rubricId,
      ownerRevision: input.cancellationGeneration, privacyRevision: input.scopeRevision, safetyRevision: input.safetyRevision };
    const contentHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    em.persist(new AiTask({ ...scope, id: taskId, owner: 'debates', operationKey: `${input.sessionId}:${input.snapshotId}:${input.variant}`,
      kind: 'debates.assess', schemaVersion: 1, workflowId: input.sessionId, stage: 'evaluating', expectedVariant: input.variant,
      preparedInputId: inputId, inputHash: contentHash, sourceUse: 'none', validityBindings,
      providerConfigurationVersion: 'openrouter-decisions-v1', modelVersion: input.model, promptVersion: 'debates-score-v1', maxAttempts: 1, deadline: input.deadline }));
    em.persist(new PreparedInput({ ...scope, id: inputId, taskId, schemaVersion: 1, payload, contentHash, artifactHandles: [],
      provenance: { transcriptSnapshotId: input.snapshotId, rubricRevisionId: input.rubricId, consentScopeHash: input.consentScopeHash }, purpose: 'debates.assess',
      audience: { owner: 'debates', sessionId: input.sessionId }, sourceUse: 'none', validityBindings, expiresAt: input.deadline, purgeAfter: input.purgeAfter }));
    em.persist(new OutboxEntry({ ...scope, topic: 'task.execute', schemaVersion: 1, recordId: taskId, deduplicationKey: `task.execute:${taskId}` })); return taskId;
  }

  /** Find bounded durable completion references without exposing another owner's output. */
  async pending(em: EntityManager, scope: InstallationScope): Promise<DebateCompletionReference[]> {
    return em.execute(`select t.id as "taskId",r.id as "resultId",t.workflow_id as "sessionId" from ai_task t join task_result r on r.task_id=t.id
      where t.installation_id=? and t.guild_id=? and t.owner='debates' and t.kind='debates.assess' and t.schema_version=1
      and not exists(select 1 from task_acceptance a where a.result_id=r.id) order by r.completed_at,r.id limit 20`, [scope.installationId, scope.guildId]);
  }

  /** Read the stored result for an expected task; no API accepts caller-supplied model output. */
  async read(em: EntityManager, scope: InstallationScope, taskId: string, sessionId: string): Promise<StoredDebateCompletion | null> {
    invariant(em.isInTransaction(), 'Debate completion requires owner transaction');
    const task = await em.findOne(AiTask, { ...scope, id: taskId, owner: 'debates', workflowId: sessionId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!task || task.kind !== 'debates.assess' || task.schemaVersion !== 1 || task.state !== 'TERMINAL' || task.sourceUse !== 'none' || !task.deadline
      || !['original', 'reversed'].includes(task.expectedVariant ?? '')) return null;
    const result = await em.findOne(TaskResult, { ...scope, taskId }, { lockMode: LockMode.PESSIMISTIC_WRITE }); if (!result) return null;
    return { taskId, resultId: result.id, sessionId, variant: task.expectedVariant as 'original' | 'reversed',
      snapshotId: task.validityBindings.transcriptSnapshotId ?? '', rubricId: task.validityBindings.rubricRevisionId ?? '',
      cancellationGeneration: task.validityBindings.ownerRevision ?? -1, scopeRevision: task.validityBindings.privacyRevision ?? -1,
      safetyRevision: task.validityBindings.safetyRevision ?? -1, model: task.modelVersion, outcome: result.outcome,
      payload: !result.payloadPurgedAt && result.purgeAfter > new Date() ? copyJson(result.payload) : null,
      acknowledged: await em.count(TaskAcceptance, { ...scope, resultId: result.id }) > 0,
      currentAttempt: result.attemptGeneration !== null && result.attemptGeneration === task.executionGeneration, deadline: new Date(task.deadline) };
  }

  /** Persist copied scores and their once-only acknowledgment atomically in the caller transaction. */
  async acknowledge(em: EntityManager, scope: InstallationScope, result: StoredDebateCompletion, decision: 'accepted' | 'discarded', at: Date): Promise<void> {
    if (await em.count(TaskAcceptance, { ...scope, resultId: result.resultId })) return;
    const task = await em.findOneOrFail(AiTask, { ...scope, id: result.taskId, owner: 'debates', workflowId: result.sessionId });
    const row = await em.findOneOrFail(TaskResult, { ...scope, id: result.resultId, taskId: task.id });
    em.persist(new TaskAcceptance({ ...scope, createdAt: at, taskId: task.id, resultId: row.id, owner: 'debates', operationKey: task.operationKey,
      sourceUse: task.sourceUse, validityBindings: task.validityBindings, decision, reason: decision === 'accepted' ? 'frozen_evaluation_accepted' : 'debate_no_longer_eligible',
      acknowledgedAt: at, workflowId: result.sessionId, stage: 'evaluating' })); row.recordOwnerAcknowledgment(at);
    await em.execute(`update outbox_entry set state='published',published_at=?,claimed_by=null,lease_until=null,row_revision=row_revision+1,updated_at=?
      where record_id=? and topic='task.complete' and state<>'published'`, [at, at, task.id]);
  }

  /** Withdrawal immediately erases prepared copies and result payloads; the SQL gate also reads current consent. */
  async invalidate(em: EntityManager, scope: InstallationScope, sessionId: string, reason: string, at: Date): Promise<void> {
    invariant(em.isInTransaction(), 'Debate invalidation requires owner transaction');
    const tasks = await em.find(AiTask, { ...scope, owner: 'debates', workflowId: sessionId }, { limit: 3, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    invariant(tasks.length <= 2, 'Debate task bound exceeded');
    for (const task of tasks) {
      const input = await em.findOneOrFail(PreparedInput, { ...scope, id: task.preparedInputId }); input.invalidate(reason, at); input.purgePayload(reason, at);
      const result = await this.read(em, scope, task.id, sessionId);
      if (result) {
        await this.acknowledge(em, scope, result, 'discarded', at);
        const row = await em.findOneOrFail(TaskResult, { ...scope, id: result.resultId });
        row.purgePayload({ reason, mode: 'privacy', ownerAcknowledged: true, now: at });
      }
    }
  }

  /** Reuse accounting/terminal primitives through the restricted Debate recovery entry point. */
  async recover(em: EntityManager): Promise<number> {
    const rows = await em.execute<{ count: number }[]>('select public.yuna_debate_recover(50) as count'); return rows[0]?.count ?? 0;
  }

  /** Delete at most the two erased, acknowledged task graphs after accounting permits removal. */
  async purgeMetadata(em: EntityManager, scope: InstallationScope, sessionId: string, cutoff: Date, at: Date): Promise<boolean> {
    invariant(em.isInTransaction(), 'Debate task cleanup requires owner transaction');
    const tasks = await em.find(AiTask, { ...scope, owner: 'debates', workflowId: sessionId }, { limit: 3, orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE });
    if (tasks.length > 2) return false;
    for (const task of tasks) {
      if (task.state !== 'TERMINAL' || task.kind !== 'debates.assess' || task.createdAt > cutoff) return false;
      const input = await em.findOneOrFail(PreparedInput, { ...scope, taskId: task.id });
      const result = await em.findOne(TaskResult, { ...scope, taskId: task.id });
      if (!input.payloadPurgedAt || !result?.payloadPurgedAt || result.pendingOwnerDiscard
        || !await em.count(TaskAcceptance, { ...scope, resultId: result.id })) return false;
      const accounting = await em.execute<{ blocked: boolean }[]>(`select exists(select 1 from usage_reservation u
        where u.installation_id=? and u.guild_id=? and u.task_id=? and (u.state not in ('settled','released') or u.purge_after>?
          or exists(select 1 from usage_entry e where e.reservation_id=u.id and (e.purge_after>? or e.accounting_state not in ('actual','no-spend'))))) as blocked`,
        [scope.installationId, scope.guildId, task.id, at, at]);
      if (accounting[0]?.blocked) return false;
    }
    for (const task of tasks) invariant(await this.usage.purgeTaskAccounting(em, scope, task.id, at), 'Debate accounting changed during locked cleanup');
    for (const task of tasks) {
      // Reciprocal job FKs and Debate result references are removed together in this owner transaction.
      for (const table of ['task_acceptance', 'task_result', 'task_attempt', 'prepared_input']) {
        await em.execute(`delete from ${table} where installation_id=? and guild_id=? and task_id=?`, [scope.installationId, scope.guildId, task.id]);
      }
      await em.execute('delete from outbox_entry where installation_id=? and guild_id=? and record_id in (?,?)', [scope.installationId, scope.guildId, task.id, task.preparedInputId]);
      await em.execute('delete from ai_task where installation_id=? and guild_id=? and id=?', [scope.installationId, scope.guildId, task.id]);
    }
    return true;
  }
}
