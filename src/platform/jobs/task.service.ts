/** Bot-owned task registration, completion acceptance and cleanup share the owner's transaction. */
import { createHash, randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { prepareReplyGenerationInput, type ReplyGenerationInput } from '../../ai/contracts/generation.contracts.js';
import { assertDiscordId, invariant, type JsonObject } from '../db/entity-values.js';
import { AiTask } from './entities/ai-task.entity.js';
import { PreparedInput } from './entities/prepared-input.entity.js';
import { OutboxEntry } from './entities/outbox-entry.entity.js';
import { TaskAcceptance } from './entities/task-acceptance.entity.js';
import { TaskResult } from './entities/task-result.entity.js';
import type { ConversationTaskCompletion, ConversationTaskScope } from './conversation-task.contracts.js';
import { UsageService } from '../usage/usage.service.js';

export type { ConversationTaskCompletion, ConversationTaskScope } from './conversation-task.contracts.js';

export interface ConversationTaskRegistration {
  installationId: string;
  guildId: string;
  requestId: string;
  input: ReplyGenerationInput;
  knowledgeChannelId?: string;
  sourceEventId: string;
  sourceRevision: number;
  safetyRevision: number;
  deadline: Date;
  purgeAfter: Date;
  model: string;
  now: Date;
}

/** Bot-side registration joins the owner's transaction; it never performs provider I/O. */
export class TaskService {
  /** Accounting owns the final permission to remove settled reservation records. */
  constructor(private readonly usage = new UsageService()) {}
  /** Persist reciprocal task/input identities and their wake-up before the owner commits. */
  registerTask(em: EntityManager, input: ConversationTaskRegistration): string {
    invariant(em.isInTransaction(), 'Task registration requires the owner transaction');
    const prepared = prepareReplyGenerationInput(input.input);
    if (prepared.approvedKnowledge?.length) assertDiscordId(input.knowledgeChannelId!);
    invariant(input.deadline.getTime() <= input.now.getTime() + 120_000, 'Conversation work must expire within two minutes');
    const taskId = randomUUID();
    const inputId = randomUUID();
    const scope = { installationId: input.installationId, guildId: input.guildId, createdAt: input.now };
    const payload = {
      text: prepared.text,
      ...(prepared.adminContext ? { adminContext: prepared.adminContext as unknown as JsonObject } : {}),
      ...(prepared.previousReply === undefined ? {} : { previousReply: prepared.previousReply }),
      ...(prepared.chatContext ? { chatContext: prepared.chatContext as unknown as JsonObject } : {}),
      ...(prepared.approvedKnowledge?.length ? { approvedKnowledge: prepared.approvedKnowledge.map(entry => ({ ...entry })) } : {}),
      maxOutputTokens: prepared.maxOutputTokens,
    };
    const contentHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const validityBindings = {
      sourceEventId: input.sourceEventId, sourceRevision: input.sourceRevision,
      safetyRevision: input.safetyRevision,
      ...(prepared.approvedKnowledge?.length ? { knowledgeBindings: prepared.approvedKnowledge.map(entry => ({ entryId: entry.entryId,
        contentHash: entry.contentHash, revision: entry.revision, channelId: input.knowledgeChannelId! })) } : {}),
    };
    em.persist(new AiTask({
      ...scope, id: taskId, owner: 'community', operationKey: input.requestId,
      kind: 'community.generate', schemaVersion: 1, workflowId: input.requestId, stage: 'generating',
      preparedInputId: inputId, inputHash: contentHash, sourceUse: 'current_source', validityBindings,
      providerConfigurationVersion: 'deepseek-direct-v1', modelVersion: input.model,
      promptVersion: 'conversation-v1', maxAttempts: 1, deadline: input.deadline,
    }));
    em.persist(new PreparedInput({
      ...scope, id: inputId, taskId, schemaVersion: 1, payload, contentHash, artifactHandles: [],
      provenance: { sourceEventId: input.sourceEventId, sourceRevision: input.sourceRevision },
      purpose: 'community.reply', audience: { owner: 'community', requestId: input.requestId },
      sourceUse: 'current_source', validityBindings, expiresAt: input.deadline, purgeAfter: input.purgeAfter,
    }));
    em.persist(new OutboxEntry({
      ...scope, topic: 'task.execute', schemaVersion: 1, recordId: taskId,
      deduplicationKey: `task.execute:${taskId}`,
    }));
    return taskId;
  }

  /** Recover a bounded batch through the same database gates used by worker claims. */
  async recoverExpired(em: EntityManager, limit = 50): Promise<number> {
    invariant(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Invalid recovery batch size');
    const rows = await em.execute<{ count: number }[]>('select public.yuna_conversation_recover(?) as count', [limit]);
    return rows[0]?.count ?? 0;
  }

  /** Scan durable unacknowledged outcomes; a lost wake-up never repeats model execution. */
  async pendingResults(em: EntityManager, scope: ConversationTaskScope, limit = 20): Promise<ConversationTaskCompletion[]> {
    invariant(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Invalid completion batch size');
    return em.execute<ConversationTaskCompletion[]>(`
      select t.id as "taskId",r.id as "resultId",t.workflow_id as "requestId",
        t.validity_bindings->>'sourceEventId' as "sourceEventId",
        (t.validity_bindings->>'sourceRevision')::integer as "sourceRevision",
        (t.validity_bindings->>'safetyRevision')::integer as "safetyRevision",r.outcome,r.payload,
        r.created_at as "resultCreatedAt",
        (extract(epoch from (a.claimed_at-t.created_at))*1000)::double precision as "queueWaitMs"
      from public.ai_task t join public.task_result r on r.task_id=t.id
      left join public.task_attempt a on a.id=r.attempt_id and a.task_id=t.id
      where t.installation_id=? and t.guild_id=? and t.owner='community' and t.kind='community.generate'
        and not exists(select 1 from public.task_acceptance a where a.result_id=r.id)
      order by r.completed_at,r.id limit ?`, [scope.installationId, scope.guildId, limit]);
  }

  /** Read the immutable owner-prepared payload for external preflight; acceptance must still recheck its live task and source gates. */
  async readInput(em: EntityManager, scope: ConversationTaskScope, taskId: string): Promise<ReplyGenerationInput | null> {
    const input = await em.findOne(PreparedInput, { ...scope, taskId, payloadPurgedAt: null });
    if (!input?.payload || !input.expiresAt || input.expiresAt <= new Date()) return null;
    try { return prepareReplyGenerationInput(input.payload as unknown as ReplyGenerationInput); } catch { return null; }
  }

  /** The owner holds admission locked; accepted content still binds to its generation's safety epoch. */
  async isResultCurrent(
    em: EntityManager, scope: ConversationTaskScope, resultId: string, safetyRevision: number,
  ): Promise<boolean> {
    invariant(em.isInTransaction(), 'Result validation requires the owner transaction');
    if (!Number.isSafeInteger(safetyRevision) || safetyRevision < 0) return false;
    const result = await em.findOne(TaskResult, { ...scope, id: resultId });
    if (!result || result.outcome !== 'success' || result.attemptGeneration === null) return false;
    const task = await em.findOne(AiTask, { ...scope, id: result.taskId });
    // These identities/bindings are immutable. Payload may already have been copied and purged.
    return Boolean(task && task.owner === 'community' && task.kind === 'community.generate'
      && task.sourceUse === 'current_source' && task.state === 'TERMINAL'
      && task.executionGeneration === result.attemptGeneration
      && task.validityBindings.safetyRevision === safetyRevision);
  }

  /** Acknowledge with the owner's transition/content copy in the same locked transaction. */
  async acknowledge(
    em: EntityManager, scope: ConversationTaskScope, completion: ConversationTaskCompletion,
    decision: 'accepted' | 'discarded', reason: string, now: Date,
  ): Promise<void> {
    invariant(em.isInTransaction(), 'Task acknowledgment requires the owner transaction');
    const task = await em.findOneOrFail(AiTask, { ...scope, id: completion.taskId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    invariant(task.owner === 'community' && task.kind === 'community.generate', 'Unexpected completion owner');
    const result = await em.findOneOrFail(TaskResult, { ...scope, id: completion.resultId, taskId: task.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    const prior = await em.findOne(TaskAcceptance, { ...scope, resultId: result.id });
    if (prior) return;
    em.persist(new TaskAcceptance({
      ...scope, createdAt: now, taskId: task.id, resultId: result.id, owner: task.owner,
      operationKey: task.operationKey, sourceUse: task.sourceUse, validityBindings: task.validityBindings,
      decision, reason, acknowledgedAt: now,
      ...(task.workflowId === null ? {} : { workflowId: task.workflowId }),
      ...(task.stage === null ? {} : { stage: task.stage }),
    }));
    result.recordOwnerAcknowledgment(now);
    // This pilot consumes signals by scanning records directly; acceptance is durable truth.
    await em.execute(`update public.outbox_entry set state='published',published_at=?,claimed_by=null,lease_until=null,
      row_revision=row_revision+1,updated_at=? where installation_id=? and guild_id=? and record_id=?
      and topic='task.complete' and state<>'published'`, [now, now, scope.installationId, scope.guildId, task.id]);
  }

  /** Caller holds the installation/source gates, so release and invalidation cannot cross. */
  async invalidateSource(em: EntityManager, scope: ConversationTaskScope, eventId: string, now: Date): Promise<void> {
    invariant(em.isInTransaction(), 'Source invalidation requires the owner transaction');
    const inputs = await em.find(PreparedInput, { ...scope, sourceEventId: eventId, eligible: true }, {
      lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' },
    });
    for (const input of inputs) input.invalidate('source_changed', now);
  }

  /** Bounded erasure retains result identity and sends unacknowledged payloads to owner discard. */
  async purgeExpired(em: EntityManager, scope: ConversationTaskScope, now: Date): Promise<void> {
    invariant(em.isInTransaction(), 'Payload cleanup requires the owner transaction');
    const inputs = await em.find(PreparedInput, { ...scope, purgeAfter: { $lte: now }, payloadPurgedAt: null }, {
      limit: 50, lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' },
    });
    for (const input of inputs) {
      input.invalidate('retention_expired', now);
      input.purgePayload('retention_expired', now);
    }
    const results = await em.find(TaskResult, { ...scope, purgeAfter: { $lte: now }, payloadPurgedAt: null }, {
      limit: 50, lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' },
    });
    for (const result of results) {
      const acknowledgment = await em.findOne(TaskAcceptance, { ...scope, resultId: result.id });
      result.purgePayload({ reason: 'retention_expired', mode: 'retention', ownerAcknowledged: acknowledgment !== null, now });
    }
  }

  /** Installation removal revokes disclosures and erases provider payloads without rewriting execution outcomes. */
  async cleanupForRemoval(em: EntityManager, scope: ConversationTaskScope, now: Date): Promise<{ disposition: 'pending' | 'retained' | 'complete'; reasonCode: string | null }> {
    invariant(em.isInTransaction(), 'Jobs cleanup requires the owner transaction');
    const inputs = await em.find(PreparedInput, { ...scope, payloadPurgedAt: null }, { limit: 50, orderBy: { id: 'asc' } });
    for (const input of inputs) { input.invalidate('installation_removal', now); input.purgePayload('installation_removal', now); }
    const results = await em.find(TaskResult, { ...scope, payloadPurgedAt: null }, { limit: 50, orderBy: { id: 'asc' } });
    for (const result of results) {
      const acknowledgment = await em.findOne(TaskAcceptance, { ...scope, resultId: result.id });
      result.purgePayload({ reason: 'installation_removal', mode: 'privacy', ownerAcknowledged: acknowledgment !== null, now });
    }
    await em.flush();
    if (await em.count(PreparedInput, { ...scope, payloadPurgedAt: null })
      || await em.count(TaskResult, { ...scope, payloadPurgedAt: null })
      || await em.count(AiTask, { ...scope, state: { $ne: 'TERMINAL' } })) return { disposition: 'pending', reasonCode: 'execution_recovery' };
    return await em.count(AiTask, scope) ? { disposition: 'retained', reasonCode: 'execution_and_accounting_metadata' }
      : { disposition: 'complete', reasonCode: null };
  }

  /** Delete an acknowledged, erased Community task graph only when its accounting lifetime is complete. */
  async purgeWorkflowMetadata(em: EntityManager, scope: ConversationTaskScope, requestId: string, cutoff: Date, now: Date): Promise<boolean> {
    invariant(em.isInTransaction(), 'Task metadata cleanup requires the owner transaction');
    const tasks = await em.find(AiTask, { ...scope, owner: 'community', workflowId: requestId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (tasks.length > 1) return false; // The implemented conversation route admits exactly one task.
    for (const task of tasks) {
      if (task.kind !== 'community.generate' || task.state !== 'TERMINAL' || task.createdAt > cutoff) return false;
      const input = await em.findOneOrFail(PreparedInput, { ...scope, taskId: task.id });
      const result = await em.findOneOrFail(TaskResult, { ...scope, taskId: task.id });
      if (!input.payloadPurgedAt || !result.payloadPurgedAt || result.pendingOwnerDiscard
        || !await em.findOne(TaskAcceptance, { ...scope, resultId: result.id })) return false;
      // A future cross-owner binding keeps the graph alive until that owner releases it.
      const references = await em.execute<{ present: boolean }[]>(`select exists(select 1 from moderation_case where expected_task_id=?)
        or exists(select 1 from moderation_finding where observation_task_result_id=? or assessment_task_result_id=?) or exists(select 1 from channel_chore where planning_result_id=?) as present`, [task.id, result.id, result.id, result.id]);
      if (references[0]?.present || !await this.usage.purgeTaskAccounting(em, scope, task.id, now)) return false;
      await em.execute('delete from task_acceptance where installation_id=? and guild_id=? and task_id=?', [scope.installationId, scope.guildId, task.id]);
      await em.execute('delete from task_result where installation_id=? and guild_id=? and task_id=?', [scope.installationId, scope.guildId, task.id]);
      await em.execute('delete from task_attempt where installation_id=? and guild_id=? and task_id=?', [scope.installationId, scope.guildId, task.id]);
      await em.execute('delete from outbox_entry where installation_id=? and guild_id=? and record_id in (?,?)', [scope.installationId, scope.guildId, task.id, input.id]);
      await em.execute('delete from prepared_input where installation_id=? and guild_id=? and task_id=?', [scope.installationId, scope.guildId, task.id]);
      await em.execute('delete from ai_task where installation_id=? and guild_id=? and id=?', [scope.installationId, scope.guildId, task.id]);
    }
    // Reciprocal deferred foreign keys require the Community owner to delete its request/delivery in this same commit.
    return true;
  }
}
