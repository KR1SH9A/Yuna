import { setTimeout as delay } from 'node:timers/promises';
import type { BotRuntimeConfig } from '../../src/platform/config/runtime-config.js';
import { createDatabaseResource } from '../../src/platform/db/db.module.js';
import { createFakeResource, type RuntimeResource } from '../../src/platform/runtime/application.js';
import { DiscordGateway } from '../../src/discord/discord.module.js';
import { GuildLifecycleService, type InstallationScope } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';

/** Bot owns Discord and workflow policy; provider keys and clients remain in the worker process. */
export function createBotResources(config: BotRuntimeConfig): readonly RuntimeResource[] {
  const database = createDatabaseResource(config);
  if (config.discord.mode === 'fake') return [database, createFakeResource('discord')];
  const discord = config.discord;
  let scope: InstallationScope | undefined;
  let administration: GuildLifecycleService | undefined;
  let conversation: ConversationService | undefined;
  let delivery: ReplyDeliveryService | undefined;
  let accepting = false;
  const pending = new Set<Promise<unknown>>();
  const gateway = new DiscordGateway({ token: discord.token, guildId: discord.guildId,
    onMessage(message) {
      if (!accepting || !conversation || !administration || !scope) return;
      const work = (async () => {
        const result = await conversation!.receiveInput(message);
        if (result === 'busy') console.warn('bot: pending conversation limit reached.');
      })();
      pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {});
      return work;
    },
    onInvalidation(reference) { return accepting ? conversation?.cancelRequest(reference) : undefined; },
    onUnavailable() { return scope ? administration?.recordAvailability(scope, false) : undefined; },
    async onAvailable() {
      if (!scope || !administration || !conversation) return;
      await conversation.cancelPending();
      await administration.recordAvailability(scope, true);
    },
  });
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  const community: RuntimeResource = {
    name: 'community',
    async start(signal) {
      const orm = database.getOrm();
      administration = new GuildLifecycleService(orm);
      scope = await administration.registerGuild(discord.guildId, discord.replyModel);
      const intake = new IntakeService();
      const tasks = new TaskService();
      conversation = new ConversationService(orm, scope, discord.replyModel, administration, intake, tasks);
      await conversation.cancelPending();
      delivery = new ReplyDeliveryService(orm, scope, administration, intake, gateway);
      const stop = AbortSignal.any([signal, controller.signal]);
      accepting = true;
      running = (async () => {
        while (!stop.aborted) {
          try {
            await tasks.recoverExpired(orm.em.fork(), 50);
            await conversation!.acceptReplyResults();
            await delivery!.recoverDueDeliveries(stop);
            await conversation!.runRetention();
          } catch { if (!stop.aborted) console.warn('bot: workflow recovery deferred after a storage/transport failure.'); }
          await delay(1000, undefined, { signal: stop }).catch(() => {});
        }
      })();
    },
    async stop() {
      accepting = false;
      controller.abort();
      await running;
      await Promise.allSettled([...pending]);
      if (scope) await administration?.recordAvailability(scope, false);
    },
  };
  return [database, gateway, community];
}
