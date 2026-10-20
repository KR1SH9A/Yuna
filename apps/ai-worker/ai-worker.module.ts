import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkerRuntimeConfig } from '../../src/platform/config/runtime-config.js';
import { createDatabaseResource } from '../../src/platform/db/db.module.js';
import { invariant } from '../../src/platform/db/entity-values.js';
import { createFakeResource, type RuntimeResource } from '../../src/platform/runtime/application.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { LlmService } from '../../src/ai/llm/llm.service.js';
import { AiTaskHandlers } from './task.handlers.js';

/** Providers and restricted SQL access only; no Discord SDK or business entity discovery. */
export function createWorkerResources(config: WorkerRuntimeConfig): readonly RuntimeResource[] {
  invariant(config.jev.mode !== 'live', 'Live Jev decisions have not been enabled for the conversation test');
  const database = createDatabaseResource(config);
  const controller = new AbortController();
  let running: Promise<void>[] = [];
  const consumer: RuntimeResource = {
    name: 'deepseek',
    async start(signal) {
      signal.throwIfAborted();
      const orm = database.getOrm();
      const rows = await orm.em.fork().execute<{ allowed: boolean }[]>("select has_function_privilege(current_user, 'public.yuna_conversation_claim(text,text)', 'EXECUTE') as allowed");
      invariant(rows[0]?.allowed, 'Worker migration/grants are missing; run db:prepare');
      const store = new WorkerTaskStore(orm);
      const model = config.deepseek.mode === 'live' ? config.deepseek.model : 'fake';
      const llm = new LlmService(config.deepseek, config.requestTimeoutMs);
      const stop = AbortSignal.any([controller.signal, signal]);
      running = Array.from({ length: config.concurrency }, () => {
        const handler = new AiTaskHandlers(store, llm, randomUUID(), model, config.requestTimeoutMs);
        return (async () => {
          while (!stop.aborted) {
            try { if (await handler.runOne(stop)) continue; }
            catch { if (!stop.aborted) console.warn('ai-worker: task storage unavailable; awaiting recovery.'); }
            await delay(1000, undefined, { signal: stop }).catch(() => {});
          }
        })();
      });
    },
    async stop() { controller.abort(); await Promise.all(running); },
  };
  return [database, consumer, ...(config.jev.mode === 'fake' ? [createFakeResource('jev')] : [])];
}
