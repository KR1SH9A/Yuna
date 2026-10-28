/** Check bot/worker composition and configuration rejection without starting live integrations. */
import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { bootstrap as bootstrapBot } from '../../apps/bot/main.js';
import { createBotResources } from '../../apps/bot/bot.module.js';
import { bootstrap as bootstrapWorker } from '../../apps/ai-worker/main.js';
import { createWorkerResources } from '../../apps/ai-worker/ai-worker.module.js';
import { loadBotConfig, loadWorkerConfig } from '../../src/platform/config/runtime-config.js';
import { createFakeResource, startApplication } from '../../src/platform/runtime/application.js';

const env = Object.freeze({
  NODE_ENV: 'test', BOT_DATABASE_URL: 'postgresql://bot@localhost/yuna', DISCORD_MODE: 'fake',
  WORKER_DATABASE_URL: 'postgresql://worker@localhost/yuna', DEEPSEEK_MODE: 'fake',
});

test('both bootstrap entry points reject invalid configuration before composing resources', async () => {
  let composed = false;
  /** Build the selected role resources without starting external I/O. */
  const compose = () => { composed = true; return []; };
  await assert.rejects(bootstrapBot({ ...env, BOT_DATABASE_URL: '' }, { compose }), /BOT_DATABASE_URL/);
  await assert.rejects(bootstrapWorker({ ...env, DEEPSEEK_MODE: '' }, { compose }), /DEEPSEEK_MODE/);
  assert.equal(composed, false);
});

test('bootstrap supplies the selected role snapshot and owns the resulting lifecycle', async () => {
  const calls: string[] = [];
  const resource = {
    name: 'test-resource',
    /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */
    async start() { calls.push('start'); },
    /** Simulate resource cleanup and expose its order or selected failure to the test. */
    async stop() { calls.push('stop'); },
  };
  const bot = await bootstrapBot(env, { /** Capture bootstrap configuration without starting external resources. */ compose(config) {
    assert.deepEqual(config, loadBotConfig(env));
    return [resource];
  } });
  const worker = await bootstrapWorker(env, { /** Capture bootstrap configuration without starting external resources. */ compose(config) {
    assert.deepEqual(config, loadWorkerConfig(env));
    return [resource];
  } });
  assert.deepEqual(calls, ['start', 'start']);
  await bot.shutdown();
  await worker.shutdown();
  assert.deepEqual(calls, ['start', 'start', 'stop', 'stop']);
});

test('bootstrap propagates cancellation before any resource starts', async () => {
  const controller = new AbortController();
  controller.abort();
  /** Build the selected role resources without starting external I/O. */
  const compose = () => [{
    name: 'unused',
    /** Simulate this resource's startup step, including the scenario's failure or cancellation checkpoint. */
    async start() { assert.fail('Cancelled bootstrap started a resource'); },
    /** Simulate resource cleanup and expose its order or selected failure to the test. */
    async stop() { assert.fail('Unattempted resource was stopped'); },
  }];
  await assert.rejects(bootstrapBot(env, { signal: controller.signal, compose }), /cancelled/);
  await assert.rejects(bootstrapWorker(env, { signal: controller.signal, compose }), /cancelled/);
});

test('composition respects fake/disabled modes without opening connections', () => {
  assert.deepEqual(createBotResources(loadBotConfig(env)).map(resource => resource.name), ['database', 'discord']);
  assert.deepEqual(createWorkerResources(loadWorkerConfig(env)).map(resource => resource.name), ['database', 'task-wakeups', 'deepseek']);
  assert.deepEqual(createWorkerResources(loadWorkerConfig({ ...env, JEV_MODE: 'fake' })).map(resource => resource.name), ['database', 'task-wakeups', 'deepseek']);
});

test('live conversation and moderation adapters compose without opening connections', async () => {
  assert.deepEqual(createBotResources(loadBotConfig({ ...env, DISCORD_MODE: 'live', DISCORD_BOT_TOKEN: 'fixture-token',
    DISCORD_GUILD_ID: '123456789012345678', REPLY_MODEL: 'fixture-model' })).map(resource => resource.name), ['database', 'bot-ownership', 'result-wakeups', 'discord', 'community']);
  assert.deepEqual(createWorkerResources(loadWorkerConfig({ ...env, DEEPSEEK_MODE: 'live', DEEPSEEK_API_KEY: 'fixture-key',
    DEEPSEEK_MODEL: 'fixture-model' })).map(resource => resource.name), ['database', 'task-wakeups', 'deepseek']);
  assert.deepEqual(createWorkerResources(loadWorkerConfig({ ...env, JEV_MODE: 'live', OPENROUTER_API_KEY: 'fixture-key',
    JEV_MODEL: 'fixture-model' })).map(resource => resource.name), ['database', 'task-wakeups', 'deepseek']);
});

test('fake lifecycle resources need no credentials and honor an already cancelled start', async () => {
  const fake = createFakeResource('test-fake');
  const app = await startApplication([fake]);
  await app.shutdown();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fake.start(controller.signal));
  await fake.stop();
});
