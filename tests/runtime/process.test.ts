/** Verify real child-process signal handling, graceful shutdown and failure exits. */
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from '@jest/globals';

interface ExitResult { code: number | null; signal: NodeJS.Signals | null; error?: Error }

/** Keep every wait bounded and retain output so a child failure explains the missing handshake. */
function startFixture(scenario: string) {
  const child = fork(fileURLToPath(new URL('../helpers/runtime-process.fixture.js', import.meta.url)), [scenario], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  let stdout = '';
  let stderr = '';
  let exited = false;
  let spawnError: Error | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise<ExitResult>((resolve) => child.once('close', (code, signal) => {
    exited = true;
    resolve({ code, signal, ...(spawnError ? { error: spawnError } : {}) });
  }));

  /** Wait for a specific child-process output marker, rejecting if the fixture exits too early. */
  function waitForText(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Missing ${text}\n${stdout}\n${stderr}`)), 3_000);
      /** Complete the fixture observation and release its listeners or pending waiters. */
      function finish(error?: Error): void {
        clearTimeout(timeout);
        child.stdout?.off('data', check);
        child.off('close', check);
        if (error) reject(error); else resolve();
      }
      /** Check whether the fixture has reached the expected observable completion condition. */
      function check(): void {
        if (stdout.includes(text)) finish();
        else if (exited) finish(new Error(`Child exited before ${text}\n${stdout}\n${stderr}`));
      }
      child.stdout?.on('data', check);
      child.on('close', check);
      check();
    });
  }

  /** Resolve when the child process exits so shutdown assertions use actual process completion. */
  async function waitForExit(): Promise<ExitResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Child did not exit\n${stdout}\n${stderr}`)), 3_000);
      })]);
    } finally { clearTimeout(timeout); }
  }

  return {
    child, waitForText, waitForExit,
    output: () => ({ stdout, stderr }),
    /** Remove the fixture listeners and stop any child process left by a failed test. */
    async dispose() {
      if (!exited) child.kill('SIGKILL');
      await waitForExit();
    },
  };
}

/** Always reap the subprocess, including when a handshake or assertion fails. */
async function withFixture(scenario: string, run: (fixture: ReturnType<typeof startFixture>) => Promise<void>): Promise<void> {
  const fixture = startFixture(scenario);
  try { await run(fixture); } finally { await fixture.dispose(); }
}

/** Send the selected operating-system signal to the test child process. */
function signal(child: ChildProcess, name: NodeJS.Signals): void {
  assert.equal(child.kill(name), true, `Child must receive ${name}`);
}

/** Assert that the child exited normally after releasing its resources. */
function assertCleanReturn(stdout: string, stopCount: number): void {
  assert.ok(stdout.includes(`fixture:returned:${JSON.stringify({ stopCount, SIGINT: 0, SIGTERM: 0 })}`));
}

for (const name of ['SIGINT', 'SIGTERM'] as const) {
  test(`${name} cleanly stops a ready process and removes its signal listeners`, async () => {
    await withFixture('normal', async (fixture) => {
      await fixture.waitForText('bot: ready.');
      signal(fixture.child, name);
      assert.deepEqual(await fixture.waitForExit(), { code: 0, signal: null });
      const { stdout, stderr } = fixture.output();
      assert.equal(stderr, '');
      assertCleanReturn(stdout, 1);
    });
  }, 10_000);
}

test('repeated mixed signals share one cleanup operation', async () => {
  await withFixture('repeated', async (fixture) => {
    await fixture.waitForText('bot: ready.');
    signal(fixture.child, 'SIGTERM');
    await fixture.waitForText('fixture:stop:1');
    signal(fixture.child, 'SIGINT');
    await fixture.waitForText('fixture:signal:SIGINT:1');
    signal(fixture.child, 'SIGTERM');
    await fixture.waitForText('fixture:signal:SIGTERM:2');
    fixture.child.send('release-stop');
    assert.deepEqual(await fixture.waitForExit(), { code: 0, signal: null });
    const { stdout, stderr } = fixture.output();
    assert.equal(stderr, '');
    assert.equal((stdout.match(/fixture:stop:/g) ?? []).length, 1);
    assertCleanReturn(stdout, 1);
  });
}, 15_000);

test('a signal during startup waits for the pending resource then rolls back cleanly', async () => {
  await withFixture('starting', async (fixture) => {
    await fixture.waitForText('fixture:starting');
    signal(fixture.child, 'SIGTERM');
    await fixture.waitForText('fixture:signal:SIGTERM:1');
    assert.ok(!fixture.output().stdout.includes('fixture:stop:'));
    fixture.child.send('release-start');
    assert.deepEqual(await fixture.waitForExit(), { code: 0, signal: null });
    const { stdout, stderr } = fixture.output();
    assert.equal(stderr, '');
    assert.ok(!stdout.includes('bot: ready.'));
    assertCleanReturn(stdout, 1);
  });
}, 10_000);

test('startup failures exit unsuccessfully without printing raw errors or their causes', async () => {
  await withFixture('startup-failure', async (fixture) => {
    assert.deepEqual(await fixture.waitForExit(), { code: 1, signal: null });
    const { stdout, stderr } = fixture.output();
    assert.match(stderr, /bot: runtime failed;/);
    assert.ok(!`${stdout}${stderr}`.includes('fixture-secret'));
    assert.ok(!stderr.includes('deadline exceeded'));
    assertCleanReturn(stdout, 0);
  });
}, 10_000);

test('a rejected startup bounds its hanging rollback without waiting for a signal', async () => {
  await withFixture('startup-hanging-rollback', async fixture => {
    await fixture.waitForText('fixture:stop:1');
    assert.deepEqual(await fixture.waitForExit(), { code: 1, signal: null });
    const { stdout, stderr } = fixture.output();
    assert.match(stderr, /runtime failed/); assert.match(stderr, /deadline exceeded/);
    assert.equal((stdout.match(/fixture:stop:/g) ?? []).length, 1);
    assert.ok(!`${stdout}${stderr}`.includes('fixture-secret'));
    assert.ok(!stdout.includes('bot: ready.')); assert.ok(!stdout.includes('fixture:signal:'));
  });
}, 10_000);

for (const scenario of ['hanging-start', 'hanging-stop']) {
  test(`the shutdown deadline terminates ${scenario}`, async () => {
    await withFixture(scenario, async (fixture) => {
      await fixture.waitForText(scenario === 'hanging-start' ? 'fixture:starting' : 'bot: ready.');
      signal(fixture.child, 'SIGTERM');
      assert.deepEqual(await fixture.waitForExit(), { code: 1, signal: null });
      assert.match(fixture.output().stderr, /bot: shutdown deadline exceeded; forcing exit\./);
    });
  }, 10_000);
}

test('failed cleanup cannot leave an active resource running beyond the shutdown deadline', async () => {
  await withFixture('leaking-stop', async (fixture) => {
    await fixture.waitForText('bot: ready.');
    signal(fixture.child, 'SIGTERM');
    assert.deepEqual(await fixture.waitForExit(), { code: 1, signal: null });
    const { stdout, stderr } = fixture.output();
    assert.match(stderr, /bot: runtime failed;/);
    assert.match(stderr, /bot: shutdown deadline exceeded; forcing exit\./);
    assert.ok(!`${stdout}${stderr}`.includes('fixture-secret'));
    assertCleanReturn(stdout, 1);
  });
}, 10_000);

test('asynchronous ownership loss shuts down once and exits nonzero without waiting for an OS signal', async () => {
  await withFixture('ownership-failure', async fixture => {
    await fixture.waitForText('bot: ready.'); fixture.child.send('lose-ownership');
    assert.deepEqual(await fixture.waitForExit(), { code: 1, signal: null });
    const { stdout, stderr } = fixture.output();
    assert.match(stderr, /bot: runtime failed;/); assert.ok(!stderr.includes('deadline exceeded'));
    assert.ok(!`${stdout}${stderr}`.includes('fixture-secret')); assert.ok(stdout.includes('fixture:ownership-released'));
    assert.ok(!stdout.includes('fixture:signal:')); assertCleanReturn(stdout, 1);
  });
}, 10_000);

for (const scenario of ['ownership-hanging-start', 'ownership-hanging-stop']) {
  test(`asynchronous ownership loss bounds cleanup for ${scenario}`, async () => {
    await withFixture(scenario, async fixture => {
      await fixture.waitForText(scenario.endsWith('start') ? 'fixture:starting' : 'bot: ready.');
      fixture.child.send('lose-ownership');
      assert.deepEqual(await fixture.waitForExit(), { code: 1, signal: null });
      const { stdout, stderr } = fixture.output();
      assert.match(stderr, /runtime failed/); assert.match(stderr, /deadline exceeded/);
      assert.ok(!`${stdout}${stderr}`.includes('fixture-secret')); assert.ok(!stdout.includes('fixture:signal:'));
    });
  }, 10_000);
}
