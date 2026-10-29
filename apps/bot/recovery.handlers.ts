/** Schedule bounded recovery and retention independently; unknown effects are reconciled by their owners. */
import { runBackgroundLoop } from '../../src/platform/runtime/background-loop.js';
import type { ConversationService } from '../../src/contexts/community/conversation.service.js';
import type { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import type { DebateService } from '../../src/contexts/debates/debate.service.js';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { TaskService } from '../../src/platform/jobs/task.service.js';
import type { GuildLifecycleService, InstallationScope } from '../../src/contexts/administration/guild-lifecycle.service.js';
import type { RemovalService } from '../../src/contexts/administration/removal.service.js';
import type { ModerationService } from '../../src/contexts/moderation/moderation.service.js';
import type { ActionExecutionService } from '../../src/contexts/moderation/action-execution.service.js';
import type { MemoryService } from '../../src/contexts/memory/memory.service.js';
import type { DebatePublicationService } from '../../src/contexts/debates/debate-publication.service.js';
import type { AuditRecorder } from '../../src/platform/audit/audit.recorder.js';
import type { ChannelChoreService } from '../../src/contexts/administration/channel-chore.service.js';

/** Create existing serial loops without doing external I/O inside retention's privacy transaction. */
export function startRecoveryHandlers(input: {
  signal: AbortSignal; orm: MikroORM; scope: InstallationScope;
  administration: Pick<GuildLifecycleService, 'lockPrivacy'>; removal: Pick<RemovalService, 'runCleanup'>;
  tasks: Pick<TaskService, 'recoverExpired'>; conversation: Pick<ConversationService, 'runRetention'>;
  delivery: Pick<ReplyDeliveryService, 'reconcileDueDeliveries'>; memory: Pick<MemoryService, 'runRetention'>;
  moderation: Pick<ModerationService, 'runRetention'>; actionExecution: Pick<ActionExecutionService, 'recoverDueActions'>;
  debates: Pick<DebateService, 'runRetention'>; debatePublication: Pick<DebatePublicationService, 'runMaintenance'>;
  audit: Pick<AuditRecorder, 'purgeExpired'>;
  chores?: Pick<ChannelChoreService, 'runMaintenance' | 'cleanup'>;
}): Promise<void>[] {
  const { signal: stop, orm, scope, administration, removal, tasks, conversation, delivery, memory,
    moderation, actionExecution, debates, debatePublication, audit } = input;
  return [
    runBackgroundLoop({ signal: stop, intervalMs: 5_000,
      /** Resume undispatched admin requests and reconcile unknown writes without repeating them. */
      async run() { await input.chores?.runMaintenance(stop); },
      /** Keep user text and external errors out of operational logs. */
      onError: () => console.warn('bot: channel chore recovery deferred.'),
    }),
    runBackgroundLoop({ signal: stop, intervalMs: 5_000,
      /** Publish accepted Debate summaries once and reconcile uncertain sends without resending them. */
      async run() { await debatePublication.runMaintenance(stop); },
      /** Avoid exposing participant text or transport errors through operational logs. */
      onError: () => console.warn('bot: Debate publication deferred after a storage/transport failure.'),
    }),
    runBackgroundLoop({ signal: stop, intervalMs: 5_000,
      /** Dispatch eligible moderation actions once and reconcile uncertain effects. */
      async run() { await actionExecution.recoverDueActions(stop); },
      /** Report a bounded background failure while allowing the durable recovery loop to retry. */
      onError: () => console.warn('bot: moderation execution deferred after a storage/transport failure.'),
    }),
    runBackgroundLoop({ signal: stop, intervalMs: 5_000,
      /** Recover expired task leases through the restricted durable task lifecycle. */
      async run() { await tasks.recoverExpired(orm.em.fork(), 50); },
      /** Report a bounded background failure while allowing the durable recovery loop to retry. */
      onError: () => console.warn('bot: task recovery deferred after a storage failure.'),
    }),
    runBackgroundLoop({ signal: stop, intervalMs: 15_000,
      /** Reconcile uncertain replies separately so slow lookups cannot delay new ready deliveries. */
      run: () => delivery.reconcileDueDeliveries(stop),
      /** Report a bounded background failure while allowing the durable recovery loop to retry. */
      onError: () => console.warn('bot: reconciliation deferred after a storage/transport failure.'),
    }),
    runBackgroundLoop({ signal: stop, intervalMs: 60_000,
      /** Run owner retention and installation cleanup after short-lived work has been fenced. */
      async run() {
        await conversation.runRetention();
        await memory.runRetention();
        await orm.em.fork().transactional(async em => {
          await administration.lockPrivacy(em, scope);
          await input.chores?.cleanup(em, new Date());
          await moderation.runRetention(em, new Date());
          await debates.runRetention(em, new Date());
          await audit.purgeExpired(em, scope);
        });
        await removal.runCleanup();
      },
      /** Report a bounded background failure while allowing the durable recovery loop to retry. */
      onError: () => console.warn('bot: retention deferred after a storage failure.'),
    }),
  ];
}
