/** Compose transport and feature owners; all provider execution stays in the separate restricted worker. */
import type { BotRuntimeConfig } from '../../src/platform/config/runtime-config.js';
import { createDatabaseResource } from '../../src/platform/db/db.module.js';
import { createFakeResource, type RuntimeResource } from '../../src/platform/runtime/application.js';
import { DiscordGateway } from '../../src/discord/discord.module.js';
import { GuildLifecycleService, type InstallationScope } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import { KnowledgeService } from '../../src/contexts/community/knowledge.service.js';
import { MemoryService } from '../../src/contexts/memory/memory.service.js';
import { DebateService } from '../../src/contexts/debates/debate.service.js';
import { DebatePublicationService } from '../../src/contexts/debates/debate-publication.service.js';
import { invariant } from '../../src/platform/db/entity-values.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { createTaskWakeup } from '../../src/platform/jobs/task-wakeup.js';
import { startCompletionHandlers } from './completion.handlers.js';
import { startRecoveryHandlers } from './recovery.handlers.js';
import { createLatencyLogger } from '../../src/platform/runtime/latency.js';
import { AuthorityService } from '../../src/contexts/administration/authority.service.js';
import { SafetyService } from '../../src/contexts/administration/safety.service.js';
import { ConfigurationService } from '../../src/contexts/administration/configuration.service.js';
import { ChannelChoreService } from '../../src/contexts/administration/channel-chore.service.js';
import { RemovalService } from '../../src/contexts/administration/removal.service.js';
import { prepareServerConfiguration } from './moderation-setup.handlers.js';
import { handleAdministrationCommand, type AdministrationCommands } from './discord.handlers.js';
import { loadPolicyConfig } from '../../src/platform/config/policy-config.js';
import { ModerationService } from '../../src/contexts/moderation/moderation.service.js';
import { StaffModerationService } from '../../src/contexts/moderation/staff-moderation.service.js';
import { ActionExecutionService } from '../../src/contexts/moderation/action-execution.service.js';
import { ModerationWorkflowService } from '../../src/contexts/moderation/moderation-workflow.service.js';
import { UserUsageService } from '../../src/platform/usage/user-usage.service.js';
import { AuditRecorder } from '../../src/platform/audit/audit.recorder.js';
import { createBotOwnership } from '../../src/platform/runtime/bot-ownership.js';

/** Bot owns Discord and workflow policy; provider keys and clients remain in the worker process. */
export function createBotResources(config: BotRuntimeConfig): readonly RuntimeResource[] {
  const database = createDatabaseResource(config);
  if (config.discord.mode === 'fake') return [database, createFakeResource('discord')];
  const wakeup = createTaskWakeup(() => database.getOrm(), 'yuna_results_ready');
  const latency = createLatencyLogger('bot');
  const discord = config.discord;
  let scope: InstallationScope | undefined;
  let administration: GuildLifecycleService | undefined;
  let conversation: ConversationService | undefined;
  let delivery: ReplyDeliveryService | undefined;
  let commands: AdministrationCommands | undefined;
  let removal: RemovalService | undefined;
  let moderation: ModerationService | undefined;
  let moderationWorkflow: ModerationWorkflowService | undefined;
  let actionExecution: ActionExecutionService | undefined;
  let chores: ChannelChoreService | undefined;
  let accepting = false;
  let policyReady = false;
  const pending = new Set<Promise<unknown>>();
  const gateway = new DiscordGateway({ token: discord.token, guildId: discord.guildId,
    /** Route retained original captures to moderation only after startup and approved configuration permit intake. */
    onOriginalMessage(provenance, capture) {
      if (!accepting || !policyReady || !moderation) return;
      const work = moderation.ingestMessage(provenance, capture).then(() => {});
      pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {});
      return work;
    },
    /** Route authenticated commands through owner services and track completion for graceful shutdown. */
    onCommand(command) {
      if (!accepting || !commands) return 'Yuna is starting or stopping. Please retry shortly.';
      const work = handleAdministrationCommand(command, commands);
      pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {});
      return work;
    },
    /** Admit eligible conversation input while tracking the callback until its transaction finishes. */
    onMessage(message) {
      if (!accepting || !policyReady || !conversation || !administration || !scope) return;
      const work = (async () => {
        const result = await conversation!.receiveInput(message);
        if (result === 'busy') console.warn('bot: pending conversation limit reached.');
      })();
      pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {});
      return work;
    },
    /** Cancel pending work when the exact Discord source is edited or deleted. */
    onInvalidation(reference) { return accepting ? conversation?.cancelRequest(reference) : undefined; },
    /** Persist the gateway outage so owners cannot rely on stale availability. */
    onUnavailable() { return scope ? administration?.recordAvailability(scope, false) : undefined; },
    /** Cancel work from the gateway gap before reopening this installation to new input. */
    async onAvailable() {
      if (!scope || !administration || !conversation) return;
      await conversation.cancelPending();
      await administration.recordAvailability(scope, true);
    },
  });
  const controller = new AbortController();
  const ownership = createBotOwnership(() => database.getOrm(), discord.guildId, () => {
    accepting = false;
    controller.abort();
    console.warn('bot: exclusive guild ownership was lost; restart is required.');
    void gateway.stop().catch(() => {});
  });
  let running: Promise<void>[] = [];
  const community: RuntimeResource = {
    name: 'community',
    /** Compose scoped owners, validate configuration and start recovery loops before opening ingress. */
    async start(signal) {
      // Validate the file before admitting traffic; applying it still requires an authenticated command.
      const configuredPolicy = await loadPolicyConfig(config.policyFile);
      if (!discord.jevModel) console.warn('bot: automatic moderation setup is unavailable because JEV_MODEL is missing from the bot environment. Match the worker JEV_MODEL, restart, then run /yuna setup.');
      invariant(configuredPolicy.features?.debates !== true || discord.jevModel !== undefined,
        'Enabled Debates require JEV_MODEL in the bot environment');
      const orm = database.getOrm();
      administration = new GuildLifecycleService(orm);
      scope = await administration.registerGuild(discord.guildId, discord.replyModel, { resumeRemoval: true });
      const intake = new IntakeService();
      const tasks = new TaskService();
      moderation = new ModerationService(orm, scope, administration, intake);
      moderationWorkflow = new ModerationWorkflowService(orm, scope, administration);
      conversation = new ConversationService(orm, scope, discord.replyModel, administration, intake, tasks, latency);
      await conversation.cancelPending();
      delivery = new ReplyDeliveryService(orm, scope, administration, intake, gateway, tasks, latency);
      /** Cancel pending Community and moderation work in the same authority or safety transaction. */
      const invalidate: ConstructorParameters<typeof AuthorityService>[2] = async (em, event) => {
        await conversation!.invalidatePending(em, event.kind, event.at);
        await moderation!.invalidatePending(em, event.kind, event.at);
      };
      const authority = new AuthorityService(orm, gateway, invalidate);
      const knowledge = new KnowledgeService(orm, scope, authority, administration,
        (em, ids, reason, at) => conversation!.invalidateKnowledge(em, ids, reason, at));
      conversation.setKnowledgeService(knowledge);
      delivery.setKnowledgeService(knowledge);
      const safety = new SafetyService(orm, authority, invalidate);
      const staffModeration = new StaffModerationService(orm, scope, authority, safety, administration);
      const userUsage = new UserUsageService(orm, scope);
      const memory = new MemoryService(orm, scope, administration);
      // The fallback is never admitted for assessment; it keeps withdrawal and cleanup available without a model selector.
      const debates = new DebateService(orm, scope, administration, discord.jevModel ?? 'unavailable');
      const debatePublication = new DebatePublicationService(orm, scope, administration, debates, gateway.createDebateTransport());
      const audit = new AuditRecorder();
      chores = new ChannelChoreService(orm, scope, administration, intake, gateway.createChannelChoreTransport(), gateway);
      conversation.setAdminAssistant(chores);
      actionExecution = new ActionExecutionService(orm, scope, authority, safety, administration, gateway.createModerationTransport());
      const configuration = new ConfigurationService(orm, authority, discord.replyModel, {
        availableFeatures: discord.jevModel ? ['memory', 'debates'] : ['memory'],
        /** Return one channel's mode and revision only after Administration has authorized its exact scope. */
        readChannelSettings: (em, channelId) => conversation!.readChannelSettings(em, channelId),
        /** Delegate channel changes to Community while preserving the enclosing authorization transaction. */
        updateChannelSettings: (em, input, at) => conversation!.updateChannelSettings(em, input, at),
        /** Read bounded Community counters for the operator status response. */
        readOperationalStatus: em => conversation!.readOperationalStatus(em),
        /** Invalidate prepared Community copies before an authorized configuration change commits. */
        invalidatePending: (em, reason, at, channelId) => conversation!.invalidatePending(em, reason, at, channelId),
        /** Publish the approved moderation policy within the same configuration transaction. */
        publishModerationPolicy: (em, caller, settings, at) => moderation!.publishPolicy(em, caller, settings, at),
      });
      removal = new RemovalService(orm, scope, authority, {
        channel_chores: { /** Erase pending payloads while the installation removal lock fences new writes. */
          async invalidate(em, at) { await chores!.cleanup(em, at, true); },
          /** Preserve explicit uncertain-attempt receipts without retaining channel names or topics. */
          cleanup: (em, at) => chores!.cleanup(em, at, true) },
        debates: { /** Removal state fences new Debate work; cleanup invalidates retained transcripts and prepared copies. */
          async invalidate(em, at) { await debates.cleanupForRemoval(em, at); },
          /** Erase Debate payloads while preserving explicit consent and uncertain-publication receipts. */
          cleanup: (em, at) => debates.cleanupForRemoval(em, at) },
        audit: { /** Audit has no outbound work; the removal transaction records and retains its own bounded outcome. */
          async invalidate() { /* Audit records are immutable observations, not effects. */ },
          /** Erase expired audit envelopes and explicitly retain those still inside their declared lifetime. */
          cleanup: (em, at) => audit.cleanupForRemoval(em, scope!, at) },
        memory: { /** Installation state already prevents new private facts; no provider copies or pending effects exist. */
          async invalidate() { /* Private memory has no pending outbound work to invalidate. */ },
          /** Erase private memory in the existing installation removal transaction. */
          cleanup: (em, at) => memory.cleanupForRemoval(em, at) },
        personal_usage: { /** Rely on the installation removal lock to fence further preference changes. */
        async invalidate() { /* Removal's installation lock already fences preference changes. */ },
          /** Erase personal usage preferences during the installation’s existing removal transaction. */
          async cleanup(em) { await userUsage.cleanupForRemoval(em); return { disposition: 'complete', reasonCode: 'personal_preferences_erased' }; } },
        community: { /** Cancel unsent Community work before installation payload cleanup begins. */
        invalidate: (em, at) => conversation!.invalidatePending(em, 'installation_removal', at),
          /** Erase Community and approved-knowledge payloads while preserving unresolved send metadata. */
          cleanup: (em, at) => conversation!.cleanupForRemoval(em, at) },
        jobs: { /** Rely on Community’s same-transaction task invalidation before Jobs cleanup. */
        async invalidate() { /* Community invalidates its prepared input in the same transaction. */ },
          /** Erase eligible task payloads while retaining unresolved execution and accounting. */
          cleanup: (em, at) => tasks.cleanupForRemoval(em, scope!, at) },
        intake: { /** Rely on installation state to fence new intake before capture cleanup. */
        async invalidate() { /* Installation state gates every future owner intake. */ },
          /** Erase retained source captures after owners have invalidated their pending uses. */
          cleanup: (em, at) => intake.cleanupForRemoval(em, scope!, at) },
        moderation: { /** Invalidate unsent moderation work before installation removal proceeds. */
        async invalidate(em, at) { await moderation!.invalidatePending(em, 'installation_removal', at); },
          /** Erase eligible moderation evidence and preserve unresolved action references. */
          cleanup: (em, at) => moderation!.cleanupForRemoval(em, at) },
      });
      policyReady = config.policyFile === undefined || await configuration.isConfigurationCurrent(scope, configuredPolicy);
      commands = { scope, authority, safety, configuration, removal, staffModeration, moderation, knowledge, memory, debates,
        debateAssessmentAvailable: discord.jevModel !== undefined, userUsage, policyFile: config.policyFile,
        /** Discover server guidance outside the later configuration transaction. */
        prepareConfiguration: (settings, autonomous) => prepareServerConfiguration(settings, { autonomous: autonomous || config.policyFile === undefined,
          guildId: discord.guildId, observationModel: discord.replyModel, assessmentModel: discord.jevModel,
          readRules: () => gateway.stateReader.readServerRules(controller.signal) }),
        /** Open intake only after the exact discovered policy has committed. */
        onConfigurationApplied: () => { policyReady = true; } };
      if (!policyReady) console.warn('bot: policy file awaits authenticated /yuna configure; new conversations are held.');
      const stop = AbortSignal.any([signal, controller.signal]);
      accepting = true;
      // Fresh replies have their own serial loop. Slow reconciliation and cleanup do not
      // occupy that loop; all mutations still use the existing scoped transaction locks.
      running = [
        ...startCompletionHandlers({ signal: stop, wakeup, conversation, delivery, moderationWorkflow, debates }),
        ...startRecoveryHandlers({ signal: stop, orm, scope, administration, removal, tasks, conversation, delivery,
          memory, moderation, actionExecution, debates, debatePublication, audit, chores }),
      ];
    },
    /** Close ingress, cancel background loops and drain callbacks before recording the installation unavailable. */
    async stop() {
      accepting = false;
      controller.abort();
      await Promise.all(running);
      await Promise.allSettled([...pending]);
      if (scope) await administration?.recordAvailability(scope, false);
    },
  };
  return [database, ownership, wakeup, gateway, community];
}
