/** Bot-owned moderation task registration/read/acknowledgment joins the feature transaction. */
import { createHash, randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { InstallationScope } from '../../contexts/administration/guild-lifecycle.service.js';
import { copyJson, invariant, type JsonObject } from '../db/entity-values.js';
import { AiTask } from './entities/ai-task.entity.js';
import { PreparedInput } from './entities/prepared-input.entity.js';
import { OutboxEntry } from './entities/outbox-entry.entity.js';
import { TaskResult } from './entities/task-result.entity.js';
import { TaskAcceptance } from './entities/task-acceptance.entity.js';
import type { ModerationCompletionReference, ModerationPreparedPayload } from './moderation-task.contracts.js';

export interface ModerationTaskRegistration extends InstallationScope {
  caseId: string; ruleId: string; caseGeneration: number; sourceEventId: string; evidenceRevisionId: string;
  policyRevisionId: string; safetyRevision: number; model: string; promptVersion: string;
  payload: ModerationPreparedPayload; now: Date; deadline: Date; purgeAfter: Date;
}
export interface StoredModerationCompletion {
  readonly taskId: string; readonly resultId: string; readonly caseId: string; readonly kind: 'moderation.observe' | 'moderation.assess';
  readonly ruleId: string; readonly caseGeneration: number; readonly evidenceRevisionId: string; readonly policyRevisionId: string;
  readonly safetyRevision: number; readonly model: string; readonly outcome: TaskResult['outcome'];
  readonly payload: JsonObject | null; readonly prepared: ModerationPreparedPayload | null; readonly acknowledged: boolean;
  readonly currentAttempt: boolean; readonly deadline: Date;
}

export class ModerationTaskService {
  /** Persist exact reciprocal identities, bounded immutable body and wake-up in the owner's transaction. */
  registerTask(em: EntityManager, input: ModerationTaskRegistration): string {
    invariant(em.isInTransaction(), 'Moderation registration requires owner transaction');
    invariant(input.deadline > input.now && input.deadline.getTime() <= input.now.getTime() + 120_000 && input.deadline <= input.purgeAfter, 'Invalid moderation deadline');
    const payload = copyJson(input.payload) as unknown as JsonObject;
    invariant(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 32 * 1024, 'Moderation prepared input exceeds boundary');
    const taskId = randomUUID(), inputId = randomUUID(), scope = { installationId: input.installationId, guildId: input.guildId, createdAt: input.now };
    const validityBindings = { sourceEventId: input.sourceEventId, evidenceRevisionId: input.evidenceRevisionId, policyRevisionId: input.policyRevisionId,
      safetyRevision: input.safetyRevision, ownerRevision: input.caseGeneration };
    const contentHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const kind = input.payload.kind;
    em.persist(new AiTask({ ...scope, id: taskId, owner: 'moderation', operationKey: `${input.caseId}:${input.caseGeneration}:${input.ruleId}`,
      kind, schemaVersion: 1, workflowId: input.caseId, stage: kind === 'moderation.observe' ? 'observing' : 'assessing', expectedVariant: input.ruleId,
      preparedInputId: inputId, inputHash: contentHash, sourceUse: 'original_evidence', validityBindings,
      providerConfigurationVersion: kind === 'moderation.observe' ? 'deepseek-observation-v1' : 'openrouter-decisions-v1',
      modelVersion: input.model, promptVersion: input.promptVersion, maxAttempts: 1, deadline: input.deadline }));
    em.persist(new PreparedInput({ ...scope, id: inputId, taskId, schemaVersion: 1, payload, contentHash, artifactHandles: [],
      provenance: { originalEventId: input.sourceEventId, evidenceRevisionId: input.evidenceRevisionId },
      purpose: kind, audience: { owner: 'moderation', caseId: input.caseId }, sourceUse: 'original_evidence', validityBindings,
      expiresAt: input.deadline, purgeAfter: input.purgeAfter }));
    em.persist(new OutboxEntry({ ...scope, topic: 'task.execute', schemaVersion: 1, recordId: taskId, deduplicationKey: `task.execute:${taskId}` }));
    return taskId;
  }

  /** Disposable completion wakes are recovered by scanning durable unacknowledged identities. */
  async pendingResults(em: EntityManager, scope: InstallationScope): Promise<ModerationCompletionReference[]> {
    return em.execute<ModerationCompletionReference[]>(`select t.id as "taskId",r.id as "resultId",t.workflow_id as "caseId"
      from ai_task t join task_result r on r.task_id=t.id where t.installation_id=? and t.guild_id=? and t.owner='moderation'
      and t.kind in ('moderation.observe','moderation.assess') and t.schema_version=1
      and not exists(select 1 from task_acceptance a where a.result_id=r.id) order by r.completed_at,r.id limit 20`, [scope.installationId, scope.guildId]);
  }

  /** Load completion and its immutable admission bindings; public callers supply references only. */
  async readCompletion(em: EntityManager, scope: InstallationScope, reference: ModerationCompletionReference): Promise<StoredModerationCompletion | null> {
    invariant(em.isInTransaction(), 'Completion read requires owner transaction');
    const task = await em.findOne(AiTask, { ...scope, id: reference.taskId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!task || task.owner !== 'moderation' || task.schemaVersion !== 1 || !['moderation.observe', 'moderation.assess'].includes(task.kind)
      || task.workflowId !== reference.caseId || task.state !== 'TERMINAL' || task.deadline === null) return null;
    const result = await em.findOne(TaskResult, { ...scope, id: reference.resultId, taskId: task.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!result) return null;
    const prepared = await em.findOneOrFail(PreparedInput, { ...scope, id: task.preparedInputId, taskId: task.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return { taskId: task.id, resultId: result.id, caseId: reference.caseId, kind: task.kind as StoredModerationCompletion['kind'],
      ruleId: task.expectedVariant ?? '', caseGeneration: task.validityBindings.ownerRevision ?? -1,
      evidenceRevisionId: task.validityBindings.evidenceRevisionId ?? '', policyRevisionId: task.validityBindings.policyRevisionId ?? '',
      safetyRevision: task.validityBindings.safetyRevision ?? -1, model: task.modelVersion, outcome: result.outcome,
      payload: result.payloadPurgedAt === null && result.purgeAfter > new Date() ? copyJson(result.payload) : null,
      prepared: prepared.payloadPurgedAt === null && prepared.purgeAfter > new Date() ? copyJson(prepared.payload) as unknown as ModerationPreparedPayload : null,
      acknowledged: await em.count(TaskAcceptance, { ...scope, resultId: result.id }) > 0,
      currentAttempt: result.attemptGeneration !== null && result.attemptGeneration === task.executionGeneration, deadline: new Date(task.deadline) };
  }

  /** Acceptance and any copied observation/finding/action commit before this disposable output is acknowledged. */
  async acknowledge(em: EntityManager, scope: InstallationScope, completion: StoredModerationCompletion,
    decision: 'accepted' | 'discarded', reason: string, now: Date): Promise<void> {
    invariant(em.isInTransaction(), 'Moderation acknowledgment requires owner transaction');
    const task = await em.findOneOrFail(AiTask, { ...scope, id: completion.taskId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    invariant(task.owner === 'moderation' && task.workflowId === completion.caseId, 'Unexpected moderation completion');
    const result = await em.findOneOrFail(TaskResult, { ...scope, id: completion.resultId, taskId: task.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (await em.count(TaskAcceptance, { ...scope, resultId: result.id })) return;
    em.persist(new TaskAcceptance({ ...scope, createdAt: now, taskId: task.id, resultId: result.id, owner: 'moderation', operationKey: task.operationKey,
      sourceUse: task.sourceUse, validityBindings: task.validityBindings, decision, reason, acknowledgedAt: now,
      workflowId: completion.caseId, stage: task.stage ?? undefined }));
    result.recordOwnerAcknowledgment(now);
    await em.execute(`update outbox_entry set state='published',published_at=?,claimed_by=null,lease_until=null,
      row_revision=row_revision+1,updated_at=? where installation_id=? and guild_id=? and record_id=?
      and topic='task.complete' and state<>'published'`, [now, now, scope.installationId, scope.guildId, task.id]);
  }

  /** Recovery fences lost/disclosed attempts and retains unresolved liability without retrying the provider. */
  async recoverExpired(em: EntityManager): Promise<number> {
    const rows = await em.execute<{ count: number }[]>('select public.yuna_moderation_recover(50) as count'); return rows[0]?.count ?? 0;
  }
}
