/** Run a small child-process fixture so shutdown and signal tests exercise real process boundaries. */
import { startApplication, type RuntimeResource } from '../../src/platform/runtime/application.js';
import { runApplicationProcess } from '../../src/platform/runtime/process.js';
import { EventEmitter } from 'node:events';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createBotOwnership } from '../../src/platform/runtime/bot-ownership.js';

// This fixture runs in a child Node process so tests exercise actual OS signal delivery.
const scenario = process.argv[2];
const baseline = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
const signals = { SIGINT: 0, SIGTERM: 0 };
const commands = new Map<string, () => void>();
let stopCount = 0;

/** IPC releases an explicit test gate; it never simulates a process signal. */
function waitForCommand(command: string): Promise<void> {
  return new Promise((resolve) => commands.set(command, resolve));
}
/** Read a parent-issued fixture command and apply only the selected test action. */
function receiveCommand(command: unknown): void {
  if (typeof command !== 'string') return;
  commands.get(command)?.();
  commands.delete(command);
}
/** Record SIGINT delivery for the parent test to inspect. */
function observeInterrupt(): void { console.info(`fixture:signal:SIGINT:${++signals.SIGINT}`); }
/** Record SIGTERM delivery for the parent test to inspect. */
function observeTerminate(): void { console.info(`fixture:signal:SIGTERM:${++signals.SIGTERM}`); }
process.on('message', receiveCommand);
process.on('SIGINT', observeInterrupt);
process.on('SIGTERM', observeTerminate);

const resource: RuntimeResource = {
  name: 'fixture-resource',
  /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */
  async start() {
    if (scenario === 'leaking-stop') setInterval(() => {}, 60_000);
    if (scenario === 'startup-hanging-rollback') throw new Error('fixture-secret-startup-credential');
    if (scenario === 'starting' || scenario === 'hanging-start' || scenario === 'ownership-hanging-start') {
      const release = scenario === 'starting' ? waitForCommand('release-start') : new Promise<void>(() => {});
      console.info('fixture:starting');
      await release;
    }
    console.info('fixture:started');
  },
  /** Simulate resource cleanup and expose its order or selected failure to the test. */
  async stop() {
    stopCount += 1;
    const release = scenario === 'repeated' ? waitForCommand('release-stop') : undefined;
    console.info(`fixture:stop:${stopCount}`);
    if (scenario === 'hanging-stop' || scenario === 'ownership-hanging-stop' || scenario === 'startup-hanging-rollback') await new Promise<void>(() => {});
    if (scenario === 'leaking-stop') throw new Error('fixture-secret-close-credential');
    await release;
    console.info('fixture:stopped');
  },
};

const resources = [resource];
if (scenario?.startsWith('ownership-')) {
  const client = Object.assign(new EventEmitter(), {
    /** Simulate an acquired dedicated PostgreSQL ownership session without a real database. */
    async query(sql: string) { return { rows: sql.includes('pg_try') ? [{ acquired: true }] : [] }; },
    /** Expose successful ownership-session destruction to the parent fixture. */
    release() { console.info('fixture:ownership-released'); },
  });
  const orm = { em: { getConnection: () => ({ getNativeClient: async () => ({ connect: async () => client }) }) } } as unknown as MikroORM;
  resources.unshift(createBotOwnership(() => orm, '123', () => console.info('fixture:ownership-lost')));
  void waitForCommand('lose-ownership').then(() => client.emit('error', new Error('fixture-secret-session-failure')));
}

await runApplicationProcess('bot', async (signal, onFailure) => {
  if (scenario === 'startup-failure') {
    throw new Error('postgresql://fixture-secret-user:fixture-secret-password@localhost/yuna', {
      cause: new Error('fixture-secret-provider-key'),
    });
  }
  return startApplication(resources, signal, onFailure);
// Deadline cases stay fast; gated success cases allow time for several parent/child handshakes.
}, scenario?.includes('hanging') || scenario === 'leaking-stop' ? 200 : 3_000);

process.off('message', receiveCommand);
process.off('SIGINT', observeInterrupt);
process.off('SIGTERM', observeTerminate);
console.info(`fixture:returned:${JSON.stringify({
  stopCount,
  SIGINT: process.listenerCount('SIGINT') - baseline.SIGINT,
  SIGTERM: process.listenerCount('SIGTERM') - baseline.SIGTERM,
})}`);
process.disconnect?.();
