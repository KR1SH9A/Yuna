import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { createDatabaseResource } from '../../src/platform/db/db.module.js';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';

let database: ReturnType<typeof temporaryPostgres>;
let inspector: MikroORM;

beforeAll(async () => {
  database = temporaryPostgres();
  inspector = new MikroORM({
    ...database.options, entities: [], discovery: { warnWhenNoEntities: false },
    ensureDatabase: false, logger: () => {},
  });
  await inspector.connect();
  await inspector.em.fork().execute('create database runtime_selected');
}, 60_000);

afterAll(async () => {
  try { await inspector?.close(true); } finally { database?.close(); }
}, 30_000);

/** Keep the private cluster socket in the URL; no local TCP database is ever contacted. */
function runtimeUrl(databaseName: string): string {
  const url = new URL(`postgresql://yuna_test@localhost:55432/${databaseName}`);
  url.searchParams.set('host', database.options.host);
  return url.href;
}

test('both runtime roles connect to the selected database and release their sessions', async () => {
  for (const role of ['bot', 'ai-worker'] as const) {
    const resource = createDatabaseResource({ role, databaseUrl: runtimeUrl('runtime_selected') });
    try {
      await resource.start(new AbortController().signal);
      const connected = await inspector.em.fork().execute<{ count: string }[]>(
        "select count(*)::text as count from pg_stat_activity where datname = 'runtime_selected'",
      );
      assert.equal(connected[0]?.count, '1');
    } finally {
      await resource.stop();
    }
    const disconnected = await inspector.em.fork().execute<{ count: string }[]>(
      "select count(*)::text as count from pg_stat_activity where datname = 'runtime_selected'",
    );
    assert.equal(disconnected[0]?.count, '0');
  }
});

test('runtime startup creates no schema, tables or migrations', async () => {
  const resource = createDatabaseResource({ role: 'bot', databaseUrl: runtimeUrl('runtime_selected') });
  const selected = new MikroORM({
    ...database.options, dbName: 'runtime_selected', entities: [],
    discovery: { warnWhenNoEntities: false }, ensureDatabase: false, logger: () => {},
  });
  try {
    await resource.start(new AbortController().signal);
    const tables = await selected.em.fork().execute<{ count: string }[]>(
      "select count(*)::text as count from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')",
    );
    assert.equal(tables[0]?.count, '0');
    const schemas = await selected.em.fork().execute<{ schema_name: string }[]>(
      "select schema_name from information_schema.schemata where schema_name not like 'pg_%' and schema_name <> 'information_schema'",
    );
    assert.deepEqual(schemas.map(row => row.schema_name), ['public']);
  } finally {
    await resource.stop();
    await selected.close(true);
  }
});

test('missing runtime databases fail without being created', async () => {
  const resource = createDatabaseResource({ role: 'bot', databaseUrl: runtimeUrl('runtime_missing') });
  try {
    await assert.rejects(resource.start(new AbortController().signal), /^Error: Database startup failed$/);
    const rows = await inspector.em.fork().execute<{ count: string }[]>(
      "select count(*)::text as count from pg_database where datname = 'runtime_missing'",
    );
    assert.equal(rows[0]?.count, '0');
  } finally {
    await resource.stop();
  }
});
