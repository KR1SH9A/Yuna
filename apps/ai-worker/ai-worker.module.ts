/** Start bounded worker lanes; each lane fairly shares conversation and moderation jobs without multiplying concurrency. */
import { TaskRegistry } from './task.registry.js';
import { randomUUID } from 'node:crypto';
import type { WorkerRuntimeConfig } from '../../src/platform/config/runtime-config.js';
import { createDatabaseResource } from '../../src/platform/db/db.module.js';
import { invariant } from '../../src/platform/db/entity-values.js';
import { type RuntimeResource } from '../../src/platform/runtime/application.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { LlmService } from '../../src/ai/llm/llm.service.js';
import { AiTaskHandlers } from './task.handlers.js';
import { DebateTaskHandlers } from './debate-task.handlers.js';
import { DebateWorkerStore } from '../../src/platform/jobs/debate-worker.store.js';
import { ModerationTaskHandlers } from './moderation-task.handlers.js';
import { ModerationWorkerStore } from '../../src/platform/jobs/moderation-worker.store.js';
import { JevService } from '../../src/ai/jev/jev.service.js';
import { createTaskWakeup } from '../../src/platform/jobs/task-wakeup.js';
import { runBackgroundLoop } from '../../src/platform/runtime/background-loop.js';
import { createLatencyLogger } from '../../src/platform/runtime/latency.js';

/** Providers and restricted SQL access only; no Discord SDK or business entity discovery. */
export function createWorkerResources(config: WorkerRuntimeConfig): readonly RuntimeResource[] {
  const database = createDatabaseResource(config);
  const wakeup = createTaskWakeup(() => database.getOrm(), 'yuna_tasks_ready');
  const latency = createLatencyLogger('ai-worker');
  const controller = new AbortController();
  let running: Promise<void>[] = [];
  const consumer: RuntimeResource = {
    name: 'deepseek',
    /** Verify restricted worker entry points, then run bounded task and maintenance loops under application cancellation. */
    async start(signal) {
      signal.throwIfAborted();
      const orm = database.getOrm();
      const rows = await orm.em.fork().execute<{ allowed: boolean }[]>("select has_function_privilege(current_user, 'public.yuna_conversation_claim(text,text)', 'EXECUTE') as allowed");
      invariant(rows[0]?.allowed, 'Worker migration/grants are missing; run db:prepare');
      const store = new WorkerTaskStore(orm);
      const model = config.deepseek.mode === 'live' ? config.deepseek.model : 'fake';
      const llm = new LlmService(config.deepseek, config.requestTimeoutMs);
      const moderationStore = new ModerationWorkerStore(orm);
      const jev = config.jev.mode === 'disabled' ? null : new JevService(config.jev, config.requestTimeoutMs);
      if (!jev) console.warn('ai-worker: automatic moderation is OFF because JEV_MODE=disabled. Set JEV_MODE=live and configure OPENROUTER_API_KEY and JEV_MODEL to enable assessment.');
      if (jev) {
        const grants = await orm.em.fork().execute<{ allowed: boolean }[]>(
          "select has_function_privilege(current_user, 'public.yuna_moderation_claim(text,text,text)', 'EXECUTE') and has_function_privilege(current_user, 'public.yuna_debate_claim(text,text)', 'EXECUTE') as allowed");
        invariant(grants[0]?.allowed, 'Moderation worker grants are missing; run db:prepare');
      }
      const stop = AbortSignal.any([controller.signal, signal]);
      running = Array.from({ length: config.concurrency }, () => {
        const handler = new AiTaskHandlers(store, llm, randomUUID(), model, config.requestTimeoutMs, latency);
        const moderation = jev ? new ModerationTaskHandlers(moderationStore, llm, jev, randomUUID(), model,
          config.jev.mode === 'live' ? config.jev.model : 'fake', config.requestTimeoutMs, latency) : null;
        const debate = jev ? new DebateTaskHandlers(new DebateWorkerStore(orm), jev, randomUUID(),
          config.jev.mode === 'live' ? config.jev.model : 'fake', config.requestTimeoutMs) : null;
        const registry = new TaskRegistry(handler, moderation, debate);
        // Each lane still claims through restricted SQL; notifications never authorize a task.
        return runBackgroundLoop({ signal: stop, wakeup, intervalMs: 5_000,
          run: () => registry.runOne(stop),
          onError: () => console.warn('ai-worker: task storage unavailable; awaiting recovery.'),
        });
      });
    },
    /** Stop worker admission, cancel outstanding loops and wait for them to finish. */
    async stop() { controller.abort(); await Promise.all(running); },
  };
  return [database, wakeup, consumer];
}
