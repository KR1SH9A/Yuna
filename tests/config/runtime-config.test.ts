/** Check role-specific environment validation without reading real credentials or opening connections. */
import assert from 'node:assert/strict';
import { loadHealthConfig } from '../../src/platform/config/runtime-config.js';
import { readFileSync } from 'node:fs';
import { inspect, parseEnv } from 'node:util';
import { test } from '@jest/globals';
import { loadBotConfig, loadWorkerConfig, type EnvironmentVariables } from '../../src/platform/config/runtime-config.js';

const botEnvironment: EnvironmentVariables = Object.freeze({
  NODE_ENV: 'development', BOT_DATABASE_URL: 'postgresql://yuna_bot@localhost:5432/yuna', DISCORD_MODE: 'fake', DISCORD_GUILD_ID: '123456789012345678', REPLY_MODEL: 'fake',
});
const workerEnvironment: EnvironmentVariables = Object.freeze({
  NODE_ENV: 'development', WORKER_DATABASE_URL: 'postgresql://yuna_worker@localhost:5432/yuna', DEEPSEEK_MODE: 'fake',
});
const liveWorkerEnvironment: EnvironmentVariables = Object.freeze({
  ...workerEnvironment, DEEPSEEK_MODE: 'live', DEEPSEEK_API_KEY: 'fixture-deepseek-key', DEEPSEEK_MODEL: 'chosen-generation-model',
  JEV_MODE: 'live', OPENROUTER_API_KEY: 'fixture-openrouter-key', JEV_MODEL: 'chosen-decision-model',
});

/** A throwing getter proves unused secrets are never read, even if they are absent from output. */
function forbidReads(env: EnvironmentVariables, names: readonly string[]): EnvironmentVariables {
  const guarded = { ...env };
  for (const name of names) {
    Object.defineProperty(guarded, name, { /** Trap an environment-property read so the test can verify that unused secrets stay unread. */ get() { throw new Error(`Unexpected configuration read: ${name}`); } });
  }
  return Object.freeze(guarded);
}

test('fake role configurations need their own database destination but no integration secrets', () => {
  assert.deepEqual(loadBotConfig(botEnvironment), {
    role: 'bot', environment: 'development', databaseUrl: botEnvironment.BOT_DATABASE_URL, discord: { mode: 'fake' },
  });
  assert.deepEqual(loadWorkerConfig(workerEnvironment), {
    role: 'ai-worker', environment: 'development', databaseUrl: workerEnvironment.WORKER_DATABASE_URL,
    concurrency: 1, requestTimeoutMs: 30_000, deepseek: { mode: 'fake' }, jev: { mode: 'disabled' },
  });
  assert.throws(() => loadBotConfig({ ...botEnvironment, BOT_DATABASE_URL: undefined, WORKER_DATABASE_URL: workerEnvironment.WORKER_DATABASE_URL }), /BOT_DATABASE_URL/);
  assert.throws(() => loadWorkerConfig({ ...workerEnvironment, WORKER_DATABASE_URL: undefined, BOT_DATABASE_URL: botEnvironment.BOT_DATABASE_URL }), /WORKER_DATABASE_URL/);
});

test('live integrations retain explicit model choices and fixed provider endpoints', () => {
  assert.deepEqual(loadBotConfig({ ...botEnvironment, NODE_ENV: 'production', DISCORD_MODE: 'live', DISCORD_BOT_TOKEN: 'fixture-discord-token' }).discord,
    { mode: 'live', token: 'fixture-discord-token', guildId: botEnvironment.DISCORD_GUILD_ID, replyModel: 'fake' });
  const worker = loadWorkerConfig({ ...liveWorkerEnvironment, NODE_ENV: 'production' });
  assert.equal(worker.environment, 'production');
  assert.deepEqual(worker.deepseek, {
    mode: 'live', endpoint: 'https://api.deepseek.com/chat/completions', apiKey: 'fixture-deepseek-key', model: 'chosen-generation-model',
  });
  assert.deepEqual(worker.jev, {
    mode: 'live', endpoint: 'https://openrouter.ai/api/alpha/decisions', apiKey: 'fixture-openrouter-key', model: 'chosen-decision-model',
  });
});

test('deployment and required integration modes must be selected explicitly', () => {
  for (const NODE_ENV of [undefined, '', 'staging', 'Production', 'production ']) {
    assert.throws(() => loadBotConfig({ ...botEnvironment, NODE_ENV }), /NODE_ENV/);
    assert.throws(() => loadWorkerConfig({ ...workerEnvironment, NODE_ENV }), /NODE_ENV/);
  }
  for (const mode of [undefined, '', 'disabled', 'LIVE', 'fake ']) {
    assert.throws(() => loadBotConfig({ ...botEnvironment, DISCORD_MODE: mode }), /DISCORD_MODE/);
    assert.throws(() => loadWorkerConfig({ ...workerEnvironment, DEEPSEEK_MODE: mode }), /DEEPSEEK_MODE/);
  }
  for (const JEV_MODE of ['', 'off', 'LIVE', 'disabled ']) {
    assert.throws(() => loadWorkerConfig({ ...workerEnvironment, JEV_MODE }), /JEV_MODE/);
  }
});

test('development and test allow independent DeepSeek and Jev selections', () => {
  for (const NODE_ENV of ['development', 'test']) {
    for (const DEEPSEEK_MODE of ['fake', 'live']) {
      for (const JEV_MODE of ['disabled', 'fake', 'live']) {
        const worker = loadWorkerConfig({ ...liveWorkerEnvironment, NODE_ENV, DEEPSEEK_MODE, JEV_MODE });
        assert.equal(worker.deepseek.mode, DEEPSEEK_MODE);
        assert.equal(worker.jev.mode, JEV_MODE);
      }
    }
    for (const DISCORD_MODE of ['fake', 'live']) {
      const bot = loadBotConfig({ ...botEnvironment, NODE_ENV, DISCORD_MODE, DISCORD_BOT_TOKEN: 'fixture-token' });
      assert.equal(bot.discord.mode, DISCORD_MODE);
    }
  }
});

test('production rejects every fake integration while allowing Jev to remain disabled', () => {
  assert.throws(() => loadBotConfig({ ...botEnvironment, NODE_ENV: 'production' }), /DISCORD_MODE.*production/);
  assert.throws(() => loadWorkerConfig({ ...liveWorkerEnvironment, NODE_ENV: 'production', DEEPSEEK_MODE: 'fake' }), /DEEPSEEK_MODE.*production/);
  assert.throws(() => loadWorkerConfig({ ...liveWorkerEnvironment, NODE_ENV: 'production', JEV_MODE: 'fake' }), /JEV_MODE.*production/);
  const worker = loadWorkerConfig({ ...liveWorkerEnvironment, NODE_ENV: 'production', JEV_MODE: undefined, OPENROUTER_API_KEY: undefined, JEV_MODEL: undefined });
  assert.equal(worker.deepseek.mode, 'live');
  assert.deepEqual(worker.jev, { mode: 'disabled' });
});

test('live credentials and models reject absent, empty, whitespace and control-character values', () => {
  for (const value of [undefined, '', ' ', ' leading', 'trailing ', 'two words', 'line\nbreak', 'tab\tvalue', 'nul\0value', 'delete\x7fvalue']) {
    assert.throws(() => loadBotConfig({ ...botEnvironment, DISCORD_MODE: 'live', DISCORD_BOT_TOKEN: value }), /DISCORD_BOT_TOKEN/);
    for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'OPENROUTER_API_KEY', 'JEV_MODEL']) {
      assert.throws(() => loadWorkerConfig({ ...liveWorkerEnvironment, [name]: value }), new RegExp(name));
    }
  }
});

test('role readers never inspect the other process settings', () => {
  const bot = forbidReads(botEnvironment, [
    'WORKER_DATABASE_URL', 'WORKER_CONCURRENCY', 'PROVIDER_REQUEST_TIMEOUT_MS',
    'DEEPSEEK_MODE', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'JEV_MODE', 'OPENROUTER_API_KEY', 'JEV_MODEL',
  ]);
  const worker = forbidReads(workerEnvironment, ['BOT_DATABASE_URL', 'DISCORD_MODE', 'DISCORD_BOT_TOKEN']);
  assert.deepEqual(loadBotConfig(bot), loadBotConfig(botEnvironment));
  assert.deepEqual(loadWorkerConfig(worker), loadWorkerConfig(workerEnvironment));
});

test('live Discord requires a single valid server ID and an explicit reply model', () => {
  const live = { ...botEnvironment, DISCORD_MODE: 'live', DISCORD_BOT_TOKEN: 'fixture-token' };
  for (const value of [undefined, '', 'not-an-id', '0', ' 123456789012345678', '123456789012345678\n']) {
    assert.throws(() => loadBotConfig({ ...live, DISCORD_GUILD_ID: value }), /DISCORD_GUILD_ID/);
  }
  for (const value of [undefined, '', ' ', 'two models', 'model\n']) {
    assert.throws(() => loadBotConfig({ ...live, REPLY_MODEL: value }), /REPLY_MODEL/);
  }
  assert.equal(loadBotConfig({ ...live, REPLY_MODEL: 'deepseek-flash' }).discord.mode, 'live');
});

test('fake and disabled integrations never read unused credentials or model settings', () => {
  const bot = forbidReads(botEnvironment, ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'REPLY_MODEL']);
  assert.deepEqual(loadBotConfig(bot).discord, { mode: 'fake' });
  for (const JEV_MODE of ['fake', 'disabled']) {
    const worker = forbidReads({ ...workerEnvironment, JEV_MODE }, ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'OPENROUTER_API_KEY', 'JEV_MODEL']);
    const config = loadWorkerConfig(worker);
    assert.deepEqual(config.deepseek, { mode: 'fake' });
    assert.deepEqual(config.jev, { mode: JEV_MODE });
  }
});

test('PostgreSQL destinations preserve supported schemes, encoding, IPv6 and connection options', () => {
  for (const databaseUrl of [
    'postgres://yuna_bot@localhost/yuna',
    'postgresql://yuna_worker:encoded%40password@db.example:5432/yuna?sslmode=verify-full',
    'postgresql://yuna_worker@[::1]:5432/yuna',
    'postgresql://user%40tenant:p%3Assword@localhost/database%20name',
  ]) {
    assert.equal(loadBotConfig({ ...botEnvironment, BOT_DATABASE_URL: databaseUrl }).databaseUrl, databaseUrl);
    assert.equal(loadWorkerConfig({ ...workerEnvironment, WORKER_DATABASE_URL: databaseUrl }).databaseUrl, databaseUrl);
  }
});

test('invalid or incomplete database destinations fail before reaching an ORM or driver', () => {
  for (const databaseUrl of [
    undefined, '', ' ', 'not-a-url', 'https://user@localhost/yuna',
    'postgresql://localhost/yuna', 'postgresql://user@/yuna', 'postgresql://user@localhost',
    'postgresql://user@localhost/', 'postgresql://user@localhost/one/two',
    'postgresql://user@localhost/yuna#fragment', 'postgresql://user@localhost:invalid/yuna',
    'postgresql://user@localhost:65536/yuna', 'postgresql://user:bad%escape@localhost/yuna',
    'postgresql://user:bad%FF@localhost/yuna', 'postgresql://user@%FF/yuna',
    'postgresql://user@localhost/database%FF', 'postgresql://user@localhost/yuna?value=%',
  ]) {
    assert.throws(() => loadBotConfig({ ...botEnvironment, BOT_DATABASE_URL: databaseUrl }), /BOT_DATABASE_URL/);
    assert.throws(() => loadWorkerConfig({ ...workerEnvironment, WORKER_DATABASE_URL: databaseUrl }), /WORKER_DATABASE_URL/);
  }
});

test('configuration failures never expose supplied secrets through messages, stacks, inspection or causes', () => {
  const secret = 'sensitive-fixture-value';
  const cases: Array<() => unknown> = [
    () => loadBotConfig({ ...botEnvironment, BOT_DATABASE_URL: `postgresql://user:${secret}@[broken/yuna` }),
    () => loadWorkerConfig({ ...workerEnvironment, WORKER_DATABASE_URL: `postgresql://user:${secret}%FF@localhost/yuna` }),
    () => loadBotConfig({ ...botEnvironment, DISCORD_MODE: 'live', DISCORD_BOT_TOKEN: `${secret}\n` }),
    () => loadWorkerConfig({ ...liveWorkerEnvironment, DEEPSEEK_API_KEY: `${secret} ` }),
    () => loadWorkerConfig({ ...liveWorkerEnvironment, OPENROUTER_API_KEY: `${secret}\0` }),
    () => loadWorkerConfig({ ...liveWorkerEnvironment, JEV_MODEL: `${secret} ` }),
    () => loadWorkerConfig({ ...workerEnvironment, WORKER_CONCURRENCY: secret }),
    () => loadWorkerConfig({ ...workerEnvironment, NODE_ENV: secret }),
  ];
  for (const operation of cases) {
    assert.throws(operation, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Invalid configuration:/);
      assert.equal(error.cause, undefined);
      assert.equal(inspect(error, { showHidden: true, depth: null }).includes(secret), false);
      assert.equal((error.stack ?? '').includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
  }
});

test('worker limits accept their inclusive bounds and reject partial or unbounded numbers', () => {
  for (const [name, property, maximum] of [
    ['WORKER_CONCURRENCY', 'concurrency', 32],
    ['PROVIDER_REQUEST_TIMEOUT_MS', 'requestTimeoutMs', 120_000],
  ] as const) {
    for (const value of [1, maximum]) {
      assert.equal(loadWorkerConfig({ ...workerEnvironment, [name]: String(value) })[property], value);
    }
    for (const value of ['', ' ', '0', '-1', '+1', '01', '1.5', '1e2', '0x10', '2workers', '1\n', 'NaN', 'Infinity', String(maximum + 1), '9007199254740992']) {
      assert.throws(() => loadWorkerConfig({ ...workerEnvironment, [name]: value }), new RegExp(name));
    }
  }
});

test('loaded snapshots are deeply frozen and independent of later environment changes', () => {
  const env: Record<string, string | undefined> = { ...botEnvironment, ...liveWorkerEnvironment, DISCORD_MODE: 'live', DISCORD_BOT_TOKEN: 'original-token' };
  const bot = loadBotConfig(env);
  const worker = loadWorkerConfig(env);
  for (const object of [bot, bot.discord, worker, worker.deepseek, worker.jev]) assert.ok(Object.isFrozen(object));
  assert.equal(Reflect.set(bot.discord, 'token', 'changed'), false);
  assert.equal(Reflect.set(worker.deepseek, 'apiKey', 'changed'), false);
  assert.equal(Reflect.set(worker, 'concurrency', 10), false);
  env.DISCORD_BOT_TOKEN = 'replacement-token';
  env.DEEPSEEK_API_KEY = 'replacement-key';
  assert.deepEqual(bot.discord, { mode: 'live', token: 'original-token', guildId: botEnvironment.DISCORD_GUILD_ID, replyModel: 'fake', jevModel: 'chosen-decision-model' });
  assert.equal(worker.deepseek.mode, 'live');
  if (worker.deepseek.mode === 'live') assert.equal(worker.deepseek.apiKey, 'fixture-deepseek-key');
  assert.deepEqual(loadBotConfig(env).discord, { mode: 'live', token: 'replacement-token', guildId: botEnvironment.DISCORD_GUILD_ID, replyModel: 'fake', jevModel: 'chosen-decision-model' });
  assert.notEqual(loadWorkerConfig(env).deepseek, worker.deepseek);
});

test('configuration loading does not mutate supplied maps or process.env', () => {
  const ambientBefore = { ...process.env };
  const explicit = Object.freeze({ ...botEnvironment, ...workerEnvironment });
  const explicitBefore = { ...explicit };
  loadBotConfig(explicit);
  loadWorkerConfig(explicit);
  assert.throws(() => loadWorkerConfig(Object.freeze({ ...explicit, DEEPSEEK_MODE: 'invalid' })));
  assert.deepEqual(explicit, explicitBefore);
  assert.deepEqual({ ...process.env }, ambientBefore);
});

test('the checked-in environment example parses and loads both roles without integration secrets', () => {
  // Tests execute from dist/tests/config; the example remains at the project root.
  const env = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));
  assert.equal(env.NODE_ENV, 'development');
  for (const key of ['DISCORD_BOT_TOKEN', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']) assert.equal(env[key], '');
  assert.notEqual(env.BOT_DATABASE_URL, env.WORKER_DATABASE_URL);
  assert.deepEqual(loadBotConfig(env).discord, { mode: 'fake' });
  const worker = loadWorkerConfig(env);
  assert.deepEqual(worker.deepseek, { mode: 'fake' });
  assert.deepEqual(worker.jev, { mode: 'disabled' });
});


test('health settings read no Discord or provider credential', () => {
  const env = { BOT_DATABASE_URL: 'postgresql://health@localhost/yuna', DISCORD_GUILD_ID: '123456789012345678',
    /** Fail if a read-only health probe tries to obtain a Discord token. */
    get DISCORD_BOT_TOKEN(): string { throw new Error('Forbidden secret access'); } };
  assert.equal(loadHealthConfig(env).role, 'bot');
  assert.throws(() => loadHealthConfig({ BOT_DATABASE_URL: env.BOT_DATABASE_URL, DISCORD_GUILD_ID: 'invalid' }));
});
