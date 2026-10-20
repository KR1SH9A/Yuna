import { startApplication, type RuntimeResource } from '../../src/platform/runtime/application.js';
import { runApplicationProcess } from '../../src/platform/runtime/process.js';

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
function receiveCommand(command: unknown): void {
  if (typeof command !== 'string') return;
  commands.get(command)?.();
  commands.delete(command);
}
function observeInterrupt(): void { console.info(`fixture:signal:SIGINT:${++signals.SIGINT}`); }
function observeTerminate(): void { console.info(`fixture:signal:SIGTERM:${++signals.SIGTERM}`); }
process.on('message', receiveCommand);
process.on('SIGINT', observeInterrupt);
process.on('SIGTERM', observeTerminate);

const resource: RuntimeResource = {
  name: 'fixture-resource',
  async start() {
    if (scenario === 'leaking-stop') setInterval(() => {}, 60_000);
    if (scenario === 'starting' || scenario === 'hanging-start') {
      const release = scenario === 'starting' ? waitForCommand('release-start') : new Promise<void>(() => {});
      console.info('fixture:starting');
      await release;
    }
    console.info('fixture:started');
  },
  async stop() {
    stopCount += 1;
    const release = scenario === 'repeated' ? waitForCommand('release-stop') : undefined;
    console.info(`fixture:stop:${stopCount}`);
    if (scenario === 'hanging-stop') await new Promise<void>(() => {});
    if (scenario === 'leaking-stop') throw new Error('fixture-secret-close-credential');
    await release;
    console.info('fixture:stopped');
  },
};

await runApplicationProcess('bot', async (signal) => {
  if (scenario === 'startup-failure') {
    throw new Error('postgresql://fixture-secret-user:fixture-secret-password@localhost/yuna', {
      cause: new Error('fixture-secret-provider-key'),
    });
  }
  return startApplication([resource], signal);
// Deadline cases stay fast; gated success cases allow time for several parent/child handshakes.
}, scenario === 'hanging-start' || scenario === 'hanging-stop' || scenario === 'leaking-stop' ? 200 : 3_000);

process.off('message', receiveCommand);
process.off('SIGINT', observeInterrupt);
process.off('SIGTERM', observeTerminate);
console.info(`fixture:returned:${JSON.stringify({
  stopCount,
  SIGINT: process.listenerCount('SIGINT') - baseline.SIGINT,
  SIGTERM: process.listenerCount('SIGTERM') - baseline.SIGTERM,
})}`);
process.disconnect?.();
