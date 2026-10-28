/** Test database resource lifecycle and safe configuration handling with controlled factories. */
import assert from 'node:assert/strict';
import { afterEach, jest, test } from '@jest/globals';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { createDatabaseResource } from '../../src/platform/db/db.module.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';

afterEach(() => { jest.restoreAllMocks(); });

/** Stub only network boundaries; real ORM construction still exercises metadata and options. */
function observeDatabase() {
  const instances: MikroORM[] = [];
  const connect = jest.spyOn(MikroORM.prototype, 'connect').mockImplementation(async function (this: MikroORM) {
    instances.push(this);
    return this.driver;
  });
  const query = jest.spyOn(EntityManager.prototype, 'execute').mockResolvedValue([]);
  const close = jest.spyOn(MikroORM.prototype, 'close').mockResolvedValue(undefined);
  return { instances, connect, query, close };
}

test('database allocation is deferred, startup is shared, and repeated shutdown closes once', async () => {
  const observed = observeDatabase();
  const database = createDatabaseResource({ role: 'ai-worker', databaseUrl: 'postgresql://worker@localhost/selected' });
  assert.equal(observed.connect.mock.calls.length, 0);
  assert.throws(() => database.getOrm(), /not ready/);
  const signal = new AbortController().signal;
  const first = database.start(signal);
  assert.equal(database.start(signal), first);
  await first;
  assert.equal(database.getOrm(), observed.instances[0]);
  assert.equal(observed.connect.mock.calls.length, 1);
  assert.equal(observed.query.mock.calls.length, 1);
  assert.equal(observed.query.mock.calls[0]?.[0], 'select 1');
  const firstStop = database.stop();
  assert.equal(database.stop(), firstStop);
  await firstStop;
  assert.throws(() => database.getOrm(), /not ready/);
  assert.equal(observed.close.mock.calls.length, 1);
  await assert.rejects(database.start(signal), /already stopped/);
});

test('worker metadata stays empty while bot composition discovers its existing entities', async () => {
  const observed = observeDatabase();
  for (const role of ['ai-worker', 'bot'] as const) {
    const database = createDatabaseResource({ role, databaseUrl: 'postgresql://role@localhost/selected' });
    await database.start(new AbortController().signal);
    const orm = observed.instances.at(-1)!;
    const names = [...orm.getMetadata().getAll().values()].map(metadata => metadata.className);
    if (role === 'ai-worker') assert.deepEqual(names, []);
    else assert.ok(names.includes('GuildInstallation'));
    assert.equal(orm.config.get('ensureDatabase'), false);
    assert.equal(orm.config.get('ensureIndexes'), false);
    assert.equal(orm.config.get('allowGlobalContext'), false);
    await database.stop();
  }
});

test('runtime URL and explicit options win over ambient MikroORM connection and discovery settings', async () => {
  const observed = observeDatabase();
  const overrides = {
    MIKRO_ORM_CLIENT_URL: 'postgresql://wrong@elsewhere/wrong', MIKRO_ORM_DB_NAME: 'wrong',
    MIKRO_ORM_HOST: 'elsewhere', MIKRO_ORM_PORT: '9999', MIKRO_ORM_USER: 'wrong', MIKRO_ORM_PASSWORD: 'wrong',
    MIKRO_ORM_ENTITIES: '/missing/ambient-entity.js', MIKRO_ORM_ENTITIES_TS: '/missing/ambient-entity.ts',
    MIKRO_ORM_SCHEMA: 'wrong', MIKRO_ORM_DEBUG: 'true', MIKRO_ORM_ALLOW_GLOBAL_CONTEXT: 'true',
    MIKRO_ORM_ENSURE_INDEXES: 'true',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const database = createDatabaseResource({ role: 'ai-worker', databaseUrl: 'postgresql://selected:fixture%40secret@localhost/chosen?sslmode=verify-full' });
    await database.start(new AbortController().signal);
    const orm = observed.instances[0]!;
    assert.equal(orm.config.get('clientUrl'), 'postgresql://selected:fixture%40secret@localhost:5432/chosen?sslmode=verify-full');
    assert.equal(orm.config.get('host'), 'localhost');
    assert.equal(orm.config.get('port'), 5432);
    assert.equal(orm.config.get('dbName'), 'chosen');
    assert.equal(orm.config.get('user'), 'selected');
    assert.equal(orm.config.get('password'), 'fixture@secret');
    assert.equal(orm.config.get('schema'), 'public');
    assert.equal(orm.config.get('debug'), false);
    assert.deepEqual(orm.config.get('entities'), []);
    assert.deepEqual(orm.config.get('entitiesTs'), []);
    assert.deepEqual(orm.config.get('driverOptions'), { connectionString: orm.config.get('clientUrl'), connectionTimeoutMillis: 5_000 });
    await database.stop();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('startup failure retains the owned ORM for cleanup without exposing driver diagnostics', async () => {
  const observed = observeDatabase();
  observed.connect.mockRejectedValue(new Error('password=sensitive-fixture'));
  const database = createDatabaseResource({ role: 'ai-worker', databaseUrl: 'postgresql://worker@localhost/selected' });
  await assert.rejects(database.start(new AbortController().signal), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Database startup failed');
    assert.equal(error.cause, undefined);
    assert.equal((error.stack ?? '').includes('sensitive-fixture'), false);
    return true;
  });
  await database.stop();
  assert.equal(observed.close.mock.calls.length, 1);
  assert.equal(observed.query.mock.calls.length, 0);
});

test('shutdown failures are shared without retaining credential-bearing driver errors', async () => {
  const observed = observeDatabase();
  observed.close.mockRejectedValue(new Error('password=sensitive-fixture'));
  const database = createDatabaseResource({ role: 'ai-worker', databaseUrl: 'postgresql://worker@localhost/selected' });
  await database.start(new AbortController().signal);
  const closing = database.stop();
  assert.equal(database.stop(), closing);
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Database shutdown failed');
    assert.equal(error.cause, undefined);
    assert.equal((error.stack ?? '').includes('sensitive-fixture'), false);
    return true;
  });
  assert.equal(observed.close.mock.calls.length, 1);
});

test('cancellation before allocation opens nothing, and stopping during startup waits for ownership', async () => {
  const observed = observeDatabase();
  const canceled = new AbortController();
  canceled.abort();
  const unopened = createDatabaseResource({ role: 'ai-worker', databaseUrl: 'postgresql://worker@localhost/selected' });
  await assert.rejects(unopened.start(canceled.signal), /canceled/);
  await unopened.stop();
  assert.equal(observed.connect.mock.calls.length, 0);
  assert.equal(observed.close.mock.calls.length, 0);

  let finishConnection!: () => void;
  const connectionGate = new Promise<void>(resolve => { finishConnection = resolve; });
  observed.connect.mockImplementation(async function (this: MikroORM) {
    await connectionGate;
    return this.driver;
  });
  const controller = new AbortController();
  const database = createDatabaseResource({ role: 'ai-worker', databaseUrl: 'postgresql://worker@localhost/selected' });
  const started = database.start(controller.signal);
  const rejected = assert.rejects(started, /canceled/);
  controller.abort();
  const stopped = database.stop();
  assert.equal(observed.close.mock.calls.length, 0);
  finishConnection();
  await Promise.all([rejected, stopped]);
  assert.equal(observed.close.mock.calls.length, 1);
});

test('schema tooling keeps its default database while explicit URLs choose their database', () => {
  assert.equal(entityOrmConfig().dbName, 'yuna');
  const config = entityOrmConfig({ clientUrl: 'postgresql://user@localhost/another' });
  assert.equal(config.dbName, undefined);
  assert.equal(config.clientUrl, 'postgresql://user@localhost/another');
});
