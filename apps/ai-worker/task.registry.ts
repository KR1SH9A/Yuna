/** Static versioned worker routes and fair scanning; only restricted stores can claim durable work. */
import type { AiTaskHandlers } from './task.handlers.js';
import type { ModerationTaskHandlers } from './moderation-task.handlers.js';
import type { DebateTaskHandlers } from './debate-task.handlers.js';

export interface WorkerRoute {
  readonly kind: 'community.generate' | 'moderation.observe' | 'moderation.assess' | 'debates.assess';
  readonly schemaVersion: 1;
  readonly runOne: (signal: AbortSignal) => Promise<boolean>;
}

/** One registry per concurrency lane; unknown versions never select a handler or silently upgrade. */
export class TaskRegistry {
  private readonly routes: readonly WorkerRoute[];
  private nextRoute = 0;

  /** Register only locally enabled implementations; no queue input or provider response can add routes. */
  constructor(conversation: Pick<AiTaskHandlers, 'runOne'>, moderation: Pick<ModerationTaskHandlers, 'runOne'> | null,
    debate: Pick<DebateTaskHandlers, 'runOne'> | null) {
    this.routes = Object.freeze([
      { kind: 'community.generate' as const, schemaVersion: 1 as const, runOne: (signal: AbortSignal) => conversation.runOne(signal) },
      ...(moderation ? (['moderation.observe', 'moderation.assess'] as const).map(kind => ({ kind, schemaVersion: 1 as const,
        runOne: (signal: AbortSignal) => moderation.runOne(signal, kind) })) : []),
      ...(debate ? [{ kind: 'debates.assess' as const, schemaVersion: 1 as const, runOne: (signal: AbortSignal) => debate.runOne(signal) }] : []),
    ].map(route => Object.freeze(route)));
  }

  /** Resolve exact trusted kind/version metadata; an absent match is explicit local incompatibility. */
  resolveHandler(kind: string, schemaVersion: number): WorkerRoute | null {
    return this.routes.find(route => route.kind === kind && route.schemaVersion === schemaVersion) ?? null;
  }

  /** Rotate even across empty queues and failures so one hot route cannot starve the other owners. */
  async runOne(signal: AbortSignal): Promise<boolean> {
    for (let scanned = 0; scanned < this.routes.length && !signal.aborted; scanned++) {
      const route = this.routes[this.nextRoute]!;
      this.nextRoute = (this.nextRoute + 1) % this.routes.length;
      if (await this.resolveHandler(route.kind, route.schemaVersion)!.runOne(signal)) return true;
    }
    return false;
  }
}
