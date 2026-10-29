/** Own explicit admin channel requests, their single Discord attempt, audit and bounded cleanup. */
import { prepareAdminContext, type AdminAssistantContext, type AdminIntent } from '../../ai/contracts/admin-assistant.contracts.js';
import type { ConversationTaskCompletion } from '../../platform/jobs/conversation-task.contracts.js';
import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { NormalizedConversationMessage, DiscordReplyRequest, DiscordSendResult } from '../../discord/contracts.js';
import { parseChannelChore, validateChannelChore, type ChannelChoreOperation, type ChannelChoreCaller, type ChannelChoreOutcome } from '../../discord/channel-chore.contracts.js';
import type { DiscordChannelChoreTransport } from '../../discord/channel-chore-transport.js';
import { IntakeService } from '../../platform/intake/intake.service.js';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { invariant } from '../../platform/db/entity-values.js';
import { GuildLifecycleService, type InstallationScope } from './guild-lifecycle.service.js';

interface ChoreRow {
  planning_request_id: string | null; id: string; actor_id: string; source_channel_id: string; source_message_id: string; source_hash: string;
  source_event_id: string; source_revision: number; safety_revision: number; operation_hash: string; operation: ChannelChoreOperation | null;
  state: 'READY' | 'DISPATCHED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN' | 'CANCELED'; result_channel_id: string | null;
  deadline: Date; dispatched_at: Date | null; replied_at: Date | null; payload_purged_at: Date | null;
}
type Transport = Pick<DiscordChannelChoreTransport, 'prepare' | 'execute' | 'reconcile'> & Partial<Pick<DiscordChannelChoreTransport, 'readPlanningChannels'>>;
type Reply = { sendReply(request: DiscordReplyRequest, signal: AbortSignal): Promise<DiscordSendResult> };

interface PlannedConversation { id: string; sourceChannelId: string; sourceMessageId: string | null; deadline: Date; purgeAfter: Date;
  audienceBinding: { requesterUserId: string | null } }

export class ChannelChoreService {
  private validatePlan: ((em: EntityManager, requestId: string) => Promise<boolean>) | undefined;

  /** Let Community own its request/context/settings checks without reading another owner's entities. */
  setPlanValidator(validate: (em: EntityManager, requestId: string) => Promise<boolean>): void {
    invariant(!this.validatePlan, 'Plan validator already attached'); this.validatePlan = validate;
  }

  /** Reuse installation/source owners; the transport receives only one validated operation, never a model tool call. */
  constructor(private readonly orm: MikroORM, private readonly scope: InstallationScope,
    private readonly lifecycle: GuildLifecycleService, private readonly intake: IntakeService,
    private readonly transport: Transport, private readonly reply: Reply, private readonly audit = new AuditRecorder()) {}

  /** Build a bounded directory for a freshly authenticated administrator; no database transaction spans Discord reads. */
  async readPlanningContext(message: NormalizedConversationMessage): Promise<AdminAssistantContext | undefined> {
    try {
      const directory = await this.transport.readPlanningChannels?.({ ...message, actorId: message.authorId }, AbortSignal.timeout(5000));
      if (!directory) return undefined;
      const rows = await this.orm.em.fork().execute<{ kind: string; channelId: string; state: 'CONFIRMED' }[]>(`select
        case when operation->>'kind'='create' then 'create' else operation->>'field' end as kind,result_channel_id as "channelId",state
        from channel_chore where installation_id=? and guild_id=? and actor_id=? and source_channel_id=? and state='CONFIRMED'
        and payload_purged_at is null and created_at > now()-interval '15 minutes' order by created_at desc limit 3`,
      [this.scope.installationId, this.scope.guildId, message.authorId, message.channelId]);
      const context = { ...directory, actorId: message.authorId, guildId: message.guildId, channelId: message.channelId,
        sourceMessageId: message.messageId, recentActions: rows.filter(row => directory.channels.some(c => c.id === row.channelId)) };
      while (JSON.stringify(context).length > 3500 && context.channels.length) {
        context.channels.pop(); context.directoryPartial = true;
        context.recentActions = context.recentActions.filter(row => context.channels.some(c => c.id === row.channelId));
      }
      return prepareAdminContext(context);
    } catch { return undefined; }
  }

  /** Resolve an allowlisted model intent with fresh native authority and current channel fields before entering acceptance. */
  async preparePlan(context: AdminAssistantContext, intent: AdminIntent, sourceHash: string): Promise<ChannelChoreOperation | null> {
    try {
      const request = intent.kind === 'create' ? intent : { ...intent, channel: intent.channelId };
      return await this.transport.prepare({ guildId: context.guildId, actorId: context.actorId, channelId: context.channelId,
        messageId: context.sourceMessageId, sourceHash }, request, AbortSignal.timeout(5000));
    } catch { return null; }
  }

  /** Join Community's locked result acceptance: exact effect intent, provenance, audit and task acknowledgment commit together. */
  async acceptPlan(em: EntityManager, request: PlannedConversation, completion: ConversationTaskCompletion,
    context: AdminAssistantContext, operation: ChannelChoreOperation, sourceHash: string, now: Date): Promise<void> {
    invariant(em.isInTransaction() && request.id === completion.requestId && context.guildId === this.scope.guildId
      && context.channelId === request.sourceChannelId && context.sourceMessageId === request.sourceMessageId
      && context.actorId === request.audienceBinding.requesterUserId, 'Invalid admin plan provenance');
    validateChannelChore(operation);
    const policy = await this.lifecycle.readPolicyConfig(em, this.scope), id = randomUUID();
    const hash = createHash('sha256').update(JSON.stringify(operation.kind === 'create' ? operation
      : { kind: operation.kind, channelId: operation.channelId, field: operation.field, value: operation.value })).digest('hex');
    const unresolved = await em.execute<{ id: string }[]>(`select id from channel_chore where installation_id=? and guild_id=?
      and operation_hash=? and state in ('DISPATCHED','UNKNOWN') limit 1`, [this.scope.installationId, this.scope.guildId, hash]);
    await em.execute(`insert into channel_chore
      (id,installation_id,guild_id,actor_id,source_channel_id,source_message_id,source_hash,source_event_id,source_revision,
      safety_revision,operation,operation_hash,state,reason,created_at,deadline,purge_after,metadata_purge_after,planning_request_id,planning_result_id)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, this.scope.installationId, this.scope.guildId, context.actorId,
      context.channelId, context.sourceMessageId, sourceHash, completion.sourceEventId, completion.sourceRevision, completion.safetyRevision,
      JSON.stringify(operation), hash, unresolved.length ? 'CANCELED' : 'READY', unresolved.length ? 'prior_outcome_unknown' : null,
      now, request.deadline, request.purgeAfter, new Date(now.getTime() + policy.retention.metadataDays * 86400_000), request.id, completion.resultId]);
    await this.record(em, id, context.actorId, 'intent', now);
  }

  /** Planned work remains bound to its accepted conversation, current channel settings and unchanged contextual messages. */
  private async planCurrent(em: EntityManager, row: ChoreRow): Promise<boolean> {
    if (!row.planning_request_id) return true;
    return this.validatePlan ? this.validatePlan(em, row.planning_request_id) : false;
  }

  /** Consume recognized current-message imperatives before ordinary chat; native admin/source checks happen outside transactions. */
  async receiveInput(message: NormalizedConversationMessage, signal: AbortSignal): Promise<boolean> {
    const request = parseChannelChore(message.text);
    if (!request) return false;
    invariant(message.guildId === this.scope.guildId, 'Wrong chore guild');
    if (signal.aborted || Date.now() - message.createdAt.getTime() > 120_000 || message.createdAt.getTime() > Date.now() + 5000) return true;
    const caller = { ...message, actorId: message.authorId };
    let operation: ChannelChoreOperation | null = null;
    try { operation = await this.transport.prepare(caller, request, signal); } catch { /* Unavailable facts cannot authorize an edit. */ }
    const prepared = operation;
    const id = await this.orm.em.fork().transactional(async em => {
      const gate = await this.lifecycle.lockAdmission(em, this.scope);
      if (!gate || signal.aborted) return null;
      const now = new Date(), deadline = new Date(now.getTime() + 120_000);
      const policy = await this.lifecycle.readPolicyConfig(em, this.scope);
      const purge = new Date(now.getTime() + policy.retention.payloadDays * 86400_000);
      const metadata = new Date(now.getTime() + policy.retention.metadataDays * 86400_000);
      const source = await this.intake.receiveInput(em, this.scope, message, now, deadline, purge, metadata, 'administration');
      if (!source) return null;
      // Admission and receipt finish together, including denied requests: replay cannot become a later command.
      const id = randomUUID();
      source.receipt.complete(source.receipt.claimGeneration, prepared ? 'handled' : 'ignored', prepared ? id : null, now);
      await em.flush();
      if (!prepared) return 'denied';
      validateChannelChore(prepared);
      const hash = createHash('sha256').update(JSON.stringify(prepared.kind === 'create' ? prepared
        : { kind: prepared.kind, channelId: prepared.channelId, field: prepared.field, value: prepared.value })).digest('hex');
      const unresolved = await em.execute<{ id: string }[]>(`select id from channel_chore where installation_id=? and guild_id=?
        and operation_hash=? and state in ('DISPATCHED','UNKNOWN') limit 1`, [this.scope.installationId, this.scope.guildId, hash]);
      await em.execute(`insert into channel_chore
        (id,installation_id,guild_id,actor_id,source_channel_id,source_message_id,source_hash,source_event_id,source_revision,
        safety_revision,operation,operation_hash,state,reason,created_at,deadline,purge_after,metadata_purge_after)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, this.scope.installationId, this.scope.guildId, message.authorId,
        message.channelId, message.messageId, message.sourceHash, source.eventId, source.revision, gate.safetyRevision,
        JSON.stringify(prepared), hash, unresolved.length ? 'CANCELED' : 'READY', unresolved.length ? 'prior_outcome_unknown' : null,
        now, deadline, purge, metadata]);
      await this.record(em, id, message.authorId, 'intent', now);
      if (unresolved.length) await this.record(em, id, message.authorId, 'canceled', now);
      return id;
    });
    if (id === 'denied') {
      await this.reply.sendReply({ ...message, content: 'I couldn’t authorize or resolve that change. Only the server owner or a Discord Administrator can request channel chores. I also need Manage Channels and an unambiguous channel name.',
        nonce: message.messageId, expectedSourceHash: message.sourceHash, deadline: new Date(Date.now() + 10_000) }, signal);
    } else if (id) { await this.dispatch(id, signal); await this.deliver(id, signal); }
    return true;
  }

  /** Commit one dispatch claim before I/O; bounded guild rates include uncertain attempts and are serialized by installation lock. */
  private async dispatch(id: string, signal: AbortSignal): Promise<void> {
    const row = await this.orm.em.fork().transactional(async em => {
      const gate = await this.lifecycle.lockAdmission(em, this.scope);
      const row = await this.read(em, id, true);
      if (!row || row.state !== 'READY') return null;
      const now = new Date();
      const source = await this.intake.current(em, this.scope, row.source_event_id, row.source_revision);
      const counts = await em.execute<{ minute: number; hour: number }[]>(`select
        count(*) filter (where dispatched_at > ?::timestamptz - interval '1 minute')::integer as minute,
        count(*)::integer as hour from channel_chore where installation_id=? and guild_id=?
        and dispatched_at > ?::timestamptz - interval '1 hour'`, [now, this.scope.installationId, this.scope.guildId, now]);
      const unresolved = await em.execute<{ id: string }[]>(`select id from channel_chore where installation_id=? and guild_id=?
        and operation_hash=? and id<>? and state in ('DISPATCHED','UNKNOWN') limit 1`,
      [this.scope.installationId, this.scope.guildId, row.operation_hash, id]);
      const valid = gate && gate.safetyRevision === row.safety_revision && row.operation && !row.payload_purged_at
        && new Date(row.deadline) > now && source?.hash === row.source_hash && !signal.aborted
        && await this.planCurrent(em, row) && counts[0]!.minute < 5 && counts[0]!.hour < 20 && unresolved.length === 0;
      await em.execute('update channel_chore set state=?,reason=?,dispatched_at=? where id=?',
        [valid ? 'DISPATCHED' : 'CANCELED', valid ? null : 'stale_or_rate_limited', valid ? now : null, id]);
      if (!valid) { await this.record(em, id, row.actor_id, 'canceled', now); return null; }
      return row;
    });
    if (!row?.operation) return;
    let outcome: ChannelChoreOutcome;
    try { outcome = await this.transport.execute(this.caller(row), row.operation, id, signal, () => this.mayWrite(row)); }
    catch { outcome = { state: 'UNKNOWN', reason: 'transport_outcome_unknown' }; }
    await this.finish(id, outcome);
  }

  /** Recheck local source, pause/removal and revision after transport reads, immediately before Discord I/O. */
  private async mayWrite(row: ChoreRow): Promise<boolean> {
    return this.orm.em.fork().transactional(async em => {
      const gate = await this.lifecycle.lockAdmission(em, this.scope);
      const current = await this.read(em, row.id, true);
      const source = await this.intake.current(em, this.scope, row.source_event_id, row.source_revision);
      return !!gate && gate.safetyRevision === row.safety_revision && current?.state === 'DISPATCHED'
        && await this.planCurrent(em, current) && !current.payload_purged_at && new Date(current.deadline) > new Date() && source?.hash === row.source_hash;
    });
  }

  /** Outcomes may be recorded after pause/removal; only attributable success resolves an earlier unknown attempt. */
  private async finish(id: string, outcome: ChannelChoreOutcome): Promise<void> {
    await this.orm.em.fork().transactional(async em => {
      await this.lifecycle.lockPrivacy(em, this.scope);
      const row = await this.read(em, id, true);
      if (!row || !['DISPATCHED', 'UNKNOWN'].includes(row.state) || row.state === outcome.state) return;
      await em.execute('update channel_chore set state=?,result_channel_id=?,reason=? where id=?',
        [outcome.state, outcome.state === 'CONFIRMED' ? outcome.channelId : null, outcome.state === 'CONFIRMED' ? null : outcome.reason, id]);
      await this.record(em, id, row.actor_id, outcome.state === 'CONFIRMED' ? 'succeeded' : outcome.state === 'FAILED' ? 'failed' : 'unknown', new Date());
    });
  }

  /** Claim one result notification; a lost notification is never a reason to repeat the server change. */
  private async deliver(id: string, signal: AbortSignal): Promise<void> {
    const row = await this.orm.em.fork().transactional(async em => {
      if (!await this.lifecycle.lockAdmission(em, this.scope)) return null;
      const row = await this.read(em, id, true);
      if (!row || row.replied_at || new Date(row.deadline) <= new Date() || ['READY', 'DISPATCHED'].includes(row.state) || row.payload_purged_at) return null;
      const source = await this.intake.current(em, this.scope, row.source_event_id, row.source_revision);
      if (source?.hash !== row.source_hash) return null;
      await em.execute('update channel_chore set replied_at=? where id=?', [new Date(), id]);
      return row;
    });
    if (!row) return;
    const content = row.state === 'CONFIRMED' ? `${row.operation?.kind === 'create' ? 'Created' : row.operation?.field === 'parent_id' ? 'Moved' : 'Updated'} <#${row.result_channel_id}>.`
      : row.state === 'UNKNOWN' ? 'Discord’s response was uncertain. I won’t repeat this change automatically; check the channel and server audit log.'
        : 'I couldn’t complete that change. Permissions, channel state or request validity may have changed, or the channel-chore rate limit was reached.';
    await this.reply.sendReply({ ...this.caller(row), content, nonce: row.source_message_id, deadline: new Date(row.deadline), expectedSourceHash: row.source_hash }, signal);
  }

  /** Recover bounded records: expired attempts become unknown, matching audit evidence can confirm, and no write is repeated. */
  async runMaintenance(signal: AbortSignal): Promise<void> {
    const rows = await this.orm.em.fork().execute<ChoreRow[]>(`select * from channel_chore where installation_id=? and guild_id=?
      and payload_purged_at is null and (state='READY' or state='DISPATCHED' and dispatched_at < now()-interval '30 seconds'
        or state='UNKNOWN' and deadline > now() or state in ('CONFIRMED','FAILED','CANCELED') and replied_at is null and deadline > now()) order by created_at limit 10`,
    [this.scope.installationId, this.scope.guildId]);
    for (const row of rows) {
      if (signal.aborted) break;
      if (row.state === 'READY') await this.dispatch(row.id, signal);
      else if (row.state === 'DISPATCHED') await this.finish(row.id, { state: 'UNKNOWN', reason: 'interrupted_dispatch' });
      if (row.operation && row.dispatched_at && ['DISPATCHED', 'UNKNOWN'].includes(row.state)) {
        const channelId = await this.transport.reconcile(this.scope.guildId, row.operation, row.id, new Date(row.dispatched_at), signal);
        if (channelId) await this.finish(row.id, { state: 'CONFIRMED', channelId });
      }
      await this.deliver(row.id, signal);
    }
  }

  /** Erase operation payloads in bounded batches; preserve only unresolved attempt metadata past ordinary expiry. */
  async cleanup(em: EntityManager, at: Date, removing = false): Promise<{ disposition: 'pending' | 'retained' | 'complete'; reasonCode: string }> {
    invariant(em.isInTransaction(), 'Chore cleanup requires the lifecycle transaction');
    const erased = await em.execute<{ id: string; actor_id: string; state: ChoreRow['state'] }[]>(`update channel_chore set operation=null,payload_purged_at=?,
      state=case when state='READY' then 'CANCELED' when state='DISPATCHED' then 'UNKNOWN' else state end,
      reason=case when state in ('READY','DISPATCHED') then 'payload_retired' else reason end
      where id in (select id from channel_chore where installation_id=? and guild_id=? and payload_purged_at is null
        and (? or purge_after <= ?) order by created_at limit 50 for update) returning id,actor_id,state`, [at, this.scope.installationId, this.scope.guildId, removing, at]);
    for (const row of erased) if (row.state === 'CANCELED' || row.state === 'UNKNOWN') {
      await this.record(em, row.id, row.actor_id, row.state === 'CANCELED' ? 'canceled' : 'unknown', at);
    }
    await em.execute(`delete from channel_chore where id in (select id from channel_chore where installation_id=? and guild_id=?
      and payload_purged_at is not null and metadata_purge_after <= ? and state not in ('DISPATCHED','UNKNOWN') limit 50)`,
    [this.scope.installationId, this.scope.guildId, at]);
    const counts = await em.execute<{ remaining: number; payloads: number }[]>(`select count(*)::integer as remaining,
      count(*) filter(where payload_purged_at is null)::integer as payloads from channel_chore where installation_id=? and guild_id=?`,
    [this.scope.installationId, this.scope.guildId]);
    return { disposition: removing && counts[0]!.payloads ? 'pending' : counts[0]!.remaining ? 'retained' : 'complete', reasonCode: 'channel_chore_receipts' };
  }

  /** Keep SQL-owned rows scoped even when a caller supplies an otherwise valid UUID. */
  private async read(em: EntityManager, id: string, lock = false): Promise<ChoreRow | null> {
    return (await em.execute<ChoreRow[]>(`select * from channel_chore where installation_id=? and guild_id=? and id=?${lock ? ' for update' : ''}`,
      [this.scope.installationId, this.scope.guildId, id]))[0] ?? null;
  }

  /** Project stored provenance onto the transport's plain caller contract. */
  private caller(row: ChoreRow): ChannelChoreCaller {
    return { guildId: this.scope.guildId, actorId: row.actor_id, channelId: row.source_channel_id, messageId: row.source_message_id, sourceHash: row.source_hash };
  }

  /** Append bounded references in the owning transaction; channel names/topics never enter audit envelopes. */
  private async record(em: EntityManager, id: string, actorId: string, outcome: 'intent' | 'succeeded' | 'failed' | 'unknown' | 'canceled', at: Date): Promise<void> {
    await this.audit.recordTransition(em, { ...this.scope, createdAt: at, occurredAt: at, origin: { kind: 'user', userId: actorId },
      operation: 'administration.channel_chore', outcome, references: [{ owner: 'administration', recordId: id, revision: 1 }],
      correlationId: id, idempotencyKey: `chore:${id}:${outcome}`, purgeAfter: new Date(at.getTime() + 7 * 86400_000) });
  }
}
