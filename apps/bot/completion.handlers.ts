/** Start independent owner completion scans; notifications wake stored-result reads and never carry authority. */
import { runBackgroundLoop } from '../../src/platform/runtime/background-loop.js';
import type { TaskWakeup } from '../../src/platform/jobs/task-wakeup.js';
import type { ConversationService } from '../../src/contexts/community/conversation.service.js';
import type { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import type { DebateService } from '../../src/contexts/debates/debate.service.js';
import type { ModerationWorkflowService } from '../../src/contexts/moderation/moderation-workflow.service.js';

/** Keep acceptance with each owner and avoid making slow publication block new completion acceptance. */
export function startCompletionHandlers(input: {
  signal: AbortSignal; wakeup: TaskWakeup;
  conversation: Pick<ConversationService, 'acceptReplyResults'>; delivery: Pick<ReplyDeliveryService, 'dispatchReadyDeliveries'>;
  moderationWorkflow: Pick<ModerationWorkflowService, 'runMaintenance'>; debates: Pick<DebateService, 'runMaintenance'>;
}): Promise<void>[] {
  const { signal: stop, wakeup, conversation, delivery, moderationWorkflow, debates } = input;
  return [
    runBackgroundLoop({ signal: stop, wakeup, intervalMs: 5_000,
      /** Accept exact frozen Debate completions independently of Discord publication latency. */
      async run() { await debates.runMaintenance(); },
      /** Keep diagnostics bounded while durable Debate owner recovery remains available. */
      onError: () => console.warn('bot: Debate assessment deferred after a storage failure.'),
    }),
    runBackgroundLoop({ signal: stop, wakeup, intervalMs: 5_000,
      /** Advance admitted moderation assessment and recover stalled owner work. */
      async run() { await moderationWorkflow.runMaintenance(); },
      /** Report a bounded background failure while allowing the durable recovery loop to retry. */
      onError: () => console.warn('bot: moderation assessment deferred after a storage failure.'),
    }),
    runBackgroundLoop({ signal: stop, wakeup, intervalMs: 5_000,
      /** Accept completed replies and dispatch ready intents without waiting for slow reconciliation. */
      async run() {
        const accepted = await conversation.acceptReplyResults();
        await delivery.dispatchReadyDeliveries(stop);
        return accepted > 0;
      },
      /** Report a bounded background failure while allowing the durable recovery loop to retry. */
      onError: () => console.warn('bot: reply processing deferred after a storage/transport failure.'),
    }),
  ];
}
