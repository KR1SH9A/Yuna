/** Verify checksummed migrations, upgrades and least-privilege roles against isolated PostgreSQL databases. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { DatabasePreparationError, prepareDatabase, type DatabasePreparationResult } from '../../src/platform/db/migrations/migrate.js';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';

let database: ReturnType<typeof temporaryPostgres>;
let inspector: MikroORM;
let initial: DatabasePreparationResult;
const connections = new Set<MikroORM>();
const selectedDatabase = 'migration_ready';

/** All roles and databases live inside this test's private Unix-socket cluster. */
function adminUrl(name: string, user = 'yuna_test'): string {
  const url = new URL(`postgresql://${user}@localhost:55432/${name}`);
  url.searchParams.set('host', database.options.host);
  return url.href;
}
/** Build isolated preparation settings with deliberately awkward passwords to test safe quoting. */
function settings(name = selectedDatabase) {
  return { adminDatabaseUrl: adminUrl(name),
    botDatabasePassword: "fixture-secret-bot'; grant yuna_bot to yuna_worker; --\\",
    workerDatabasePassword: "fixture-secret-worker\\password'quote" };
}
/** Open the selected fixture connection without using production environment credentials. */
function connect(name: string, user = 'yuna_test'): MikroORM {
  const orm = new MikroORM({ ...database.options, dbName: name, user, entities: [], entitiesTs: [],
    discovery: { warnWhenNoEntities: false }, ensureDatabase: false, preferEnvVars: false, debug: false, logger: () => {} });
  connections.add(orm);
  return orm;
}
/** Check that preparation returns the expected safe classification without leaking fixture secrets. */
function safePreparationError(code: DatabasePreparationError['code']): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof DatabasePreparationError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.ok(!`${inspect(error)}${error.stack}${JSON.stringify(error)}`.includes('fixture-secret'));
    return true;
  };
}

beforeAll(async () => {
  database = temporaryPostgres();
  inspector = connect('postgres');
  await inspector.em.fork().execute(`create database ${selectedDatabase}`);
  initial = await prepareDatabase(settings());
}, 60_000);
afterAll(async () => {
  try { await Promise.all([...connections].map(orm => orm.close(true))); }
  finally { database?.close(); }
}, 30_000);

test('initial preparation applies twelve checksummed migrations and repeat preparation is idempotent', async () => {
  assert.deepEqual(initial.migrations.map(row => row.status), Array(12).fill('applied'));
  assert.deepEqual(initial.roles, ['yuna_bot', 'yuna_worker']);
  assert.equal(initial.database, selectedDatabase);
  const repeated = await prepareDatabase(settings());
  assert.deepEqual(repeated.migrations.map(row => row.status), Array(12).fill('already_applied'));
  assert.ok(Object.isFrozen(repeated) && Object.isFrozen(repeated.migrations));
  const orm = connect(selectedDatabase);
  const rows = await orm.em.fork().execute<{ version: number; checksum: string }[]>(
    'select version,checksum from public.yuna_schema_migrations order by version');
  assert.deepEqual(rows.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.checksum)));
  const roles = await inspector.em.fork().execute<{ unsafe: boolean }[]>(`select
    rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolreplication or rolbypassrls or not rolcanlogin as unsafe
    from pg_roles where rolname in ('yuna_bot','yuna_worker')`);
  assert.equal(roles.length, 2);
  assert.ok(roles.every(role => !role.unsafe));
  const memberships = await inspector.em.fork().execute<{ count: number }[]>(`select count(*)::integer as count from pg_auth_members
    where member in (select oid from pg_roles where rolname in ('yuna_bot','yuna_worker'))`);
  assert.equal(memberships[0]?.count, 0, 'Quoted passwords cannot inject a role grant');
});

test('existing earlier databases upgrade without rewriting migration history or data', async () => {
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    const name = `migration_upgrade_v${version}`;
    await inspector.em.fork().execute(`create database ${name}`);
    const orm = connect(name);
    await orm.em.fork().execute(`create table public.yuna_schema_migrations (
      version integer primary key, name text not null unique, checksum text not null,
      applied_at timestamptz not null default now());
      create table public.upgrade_probe(value text); insert into public.upgrade_probe values('preserve')`);
    const oldRows: { version: number; name: string; checksum: string }[] = [];
    for (const [index, migrationName] of ['001-core.sql', 'conversation-worker.sql', '003-conversation-notifications.sql', '004-operating-controls.sql', '005-moderation-worker.sql', '006-user-quotas.sql', '007-knowledge-context.sql', '008-memory.sql', '009-debates.sql', '010-chat-context.sql', '011-channel-chores.sql'].slice(0, version).entries()) {
      const sql = await readFile(new URL(`../../../src/platform/db/migrations/${migrationName}`, import.meta.url), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      await orm.em.fork().execute(sql);
      const row = { version: index + 1, name: migrationName, checksum };
      await orm.em.fork().execute('insert into public.yuna_schema_migrations(version,name,checksum) values(?,?,?)',
        [row.version, row.name, row.checksum]);
      oldRows.push(row);
    }
    const upgraded = await prepareDatabase(settings(name));
    assert.deepEqual(upgraded.migrations.map(row => row.status),
      Array.from({ length: 12 }, (_, index) => index < version ? 'already_applied' : 'applied'));
    const history = await orm.em.fork().execute<{ version: number; name: string; checksum: string }[]>(
      'select version,name,checksum from public.yuna_schema_migrations order by version');
    assert.deepEqual(history.slice(0, version), oldRows);
    assert.equal(history[2]?.name, '003-conversation-notifications.sql');
    assert.deepEqual(await orm.em.fork().execute('select value from public.upgrade_probe'), [{ value: 'preserve' }]);
    const triggers = await orm.em.fork().execute<{ count: number }[]>(`select count(*)::integer as count from pg_trigger
      where not tgisinternal and tgname in ('ai_task_notify_ready','task_result_notify_ready')`);
    assert.equal(triggers[0]?.count, 2);
  }
}, 20_000);

test('the initial migration remains immutable and additive migrations preserve its guards', async () => {
  const migration = await readFile(new URL('../../../src/platform/db/migrations/001-core.sql', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(migration).digest('hex'), '98529b0755b79b3df7e932691acd29885c83961298f91993c9ba88478f3c5e11');
  const orm = connect(selectedDatabase);
  const tables = await orm.em.fork().execute<{ count: number }[]>(`select count(*)::integer as count
    from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`);
  assert.equal(tables[0]?.count, 40, 'Core, quota, private Memory, Debate tables, channel chores and the migration ledger');
  const guards = await orm.em.fork().execute<{ conname: string }[]>(`select conname from pg_constraint where conname in
    ('prepared_input_privacy_scope_id_disabled','reply_delivery_accepted_result_fk','moderation_action_exact_evidence_fk','ai_task_prepared_input_id_scope_fk')`);
  assert.equal(guards.length, 4);
  const triggers = await orm.em.fork().execute<{ tgname: string }[]>(`select tgname from pg_trigger where not tgisinternal
    and tgname in ('task_result_immutable','ai_task_execution_consistency','evidence_original_guard','moderation_action_intent_guard')`);
  assert.equal(triggers.length, 4);
});

test('actual runtime logins have only their enabled data and function privileges, with no permanent DDL', async () => {
  const worker = connect(selectedDatabase, 'yuna_worker');
  const bot = connect(selectedDatabase, 'yuna_bot');
  const claim = await worker.em.fork().execute<{ claim: unknown }[]>(
    "select public.yuna_conversation_claim('setup-test','nonexistent-model') as claim");
  assert.equal(claim[0]?.claim, null);
  for (const table of ['prepared_input', 'task_result', 'guild_installation', 'moderation_case', 'yuna_schema_migrations']) {
    await assert.rejects(worker.em.fork().execute(`select * from public.${table}`), /permission denied/i);
  }
  await assert.rejects(worker.em.fork().execute('set role yuna_test'), /permission denied/i);
  await assert.rejects(worker.em.fork().execute('select public.yuna_conversation_recover(1)'), /permission denied/i);
  await assert.rejects(worker.em.fork().execute("select public.yuna_conversation_gate('00000000-0000-0000-0000-000000000000')"), /permission denied/i);
  await bot.em.fork().execute('select * from public.conversation_request');
  await bot.em.fork().execute('select * from public.capability_grant');
  await bot.em.fork().execute('select * from public.audit_entry');
  await bot.em.fork().execute('select * from public.moderation_case');
  await bot.em.fork().execute('select * from public.evidence_revision');
  await bot.em.fork().execute('select public.yuna_conversation_recover(1)');
  for (const table of ['artifact_record', 'yuna_schema_migrations']) {
    await assert.rejects(bot.em.fork().execute(`select * from public.${table}`), /permission denied/i);
  }
  for (const orm of [worker, bot]) {
    await assert.rejects(orm.em.fork().execute('select public.yuna_notify_tasks_ready()'), /permission denied/i);
    await assert.rejects(orm.em.fork().execute('select public.yuna_notify_results_ready()'), /permission denied/i);
    await assert.rejects(orm.em.fork().execute('create table public.runtime_ddl_is_forbidden(id integer)'), /permission denied/i);
    await assert.rejects(orm.em.fork().execute('alter table public.conversation_request add column forbidden integer'), /must be owner|permission denied/i);
  }
});

test('checksum tampering and unknown migration versions stop setup without exposing secrets', async () => {
  const orm = connect(selectedDatabase);
  const before = await orm.em.fork().execute<{ checksum: string }[]>('select checksum from public.yuna_schema_migrations where version=1');
  try {
    await orm.em.fork().execute('update public.yuna_schema_migrations set checksum=? where version=1', ['0'.repeat(64)]);
    await assert.rejects(prepareDatabase(settings()), safePreparationError('migration_mismatch'));
  } finally { await orm.em.fork().execute('update public.yuna_schema_migrations set checksum=? where version=1', [before[0]!.checksum]); }
  try {
    await orm.em.fork().execute("insert into public.yuna_schema_migrations(version,name,checksum) values(99,'unknown.sql',?)", ['0'.repeat(64)]);
    await assert.rejects(prepareDatabase(settings()), safePreparationError('migration_mismatch'));
  } finally { await orm.em.fork().execute('delete from public.yuna_schema_migrations where version=99'); }
});

test('a failed schema migration rolls back new objects and leaves existing unrelated objects intact', async () => {
  await inspector.em.fork().execute('create database migration_conflict');
  const orm = connect('migration_conflict');
  await orm.em.fork().execute("create table public.ai_task(probe text); create table public.unrelated(probe text); insert into public.unrelated values('keep')");
  const before = await orm.em.fork().execute<{ allowed: boolean }[]>("select has_schema_privilege('yuna_worker','public','CREATE') as allowed");
  await assert.rejects(prepareDatabase(settings('migration_conflict')), safePreparationError('preparation_failed'));
  const tables = await orm.em.fork().execute<{ table_name: string }[]>(`select table_name from information_schema.tables
    where table_schema='public' and table_type='BASE TABLE' order by table_name`);
  assert.deepEqual(tables.map(row => row.table_name), ['ai_task', 'unrelated']);
  assert.deepEqual(await orm.em.fork().execute('select probe from public.unrelated'), [{ probe: 'keep' }]);
  const after = await orm.em.fork().execute<{ allowed: boolean }[]>("select has_schema_privilege('yuna_worker','public','CREATE') as allowed");
  assert.equal(after[0]?.allowed, before[0]?.allowed, 'Schema privilege changes roll back with migration failure');
});

test('existing runtime roles with elevated flags, memberships or owned objects are refused', async () => {
  const orm = connect(selectedDatabase);
  try {
    await inspector.em.fork().execute('alter role yuna_worker createdb');
    await assert.rejects(prepareDatabase(settings()), safePreparationError('unsafe_runtime_role'));
  } finally { await inspector.em.fork().execute('alter role yuna_worker nocreatedb'); }
  await inspector.em.fork().execute('create role migration_extra noinherit');
  try {
    await inspector.em.fork().execute('grant migration_extra to yuna_worker');
    await assert.rejects(prepareDatabase(settings()), safePreparationError('unsafe_runtime_role'));
  } finally {
    await inspector.em.fork().execute('revoke migration_extra from yuna_worker');
    await inspector.em.fork().execute('drop role migration_extra');
  }
  try {
    await orm.em.fork().execute('create schema migration_owned authorization yuna_worker');
    await assert.rejects(prepareDatabase(settings()), safePreparationError('unsafe_runtime_role'));
  } finally { await orm.em.fork().execute('drop schema migration_owned'); }
});

test('runtime credentials and nonowner admin accounts cannot run preparation', async () => {
  await assert.rejects(prepareDatabase({ ...settings(), adminDatabaseUrl: adminUrl(selectedDatabase, 'yuna_bot') }), safePreparationError('invalid_configuration'));
  await inspector.em.fork().execute('create role migration_nonowner login noinherit');
  try {
    await assert.rejects(prepareDatabase({ ...settings(), adminDatabaseUrl: adminUrl(selectedDatabase, 'migration_nonowner') }), safePreparationError('unsafe_administrator'));
  } finally { await inspector.em.fork().execute('drop role migration_nonowner'); }
});

test('direct grants to internal worker helpers are detected without accepting privilege drift', async () => {
  const orm = connect(selectedDatabase);
  for (const identity of ['public.yuna_conversation_gate(uuid)', 'public.yuna_notify_tasks_ready()', 'public.yuna_notify_results_ready()']) {
    try {
      await orm.em.fork().execute(`grant execute on function ${identity} to yuna_worker`);
      await assert.rejects(prepareDatabase(settings()), safePreparationError('unsafe_runtime_role'));
    } finally { await orm.em.fork().execute(`revoke execute on function ${identity} from yuna_worker`); }
  }
});

test('concurrent preparation serializes migration application instead of duplicating its history', async () => {
  await inspector.em.fork().execute('create database migration_concurrent');
  const results = await Promise.all([prepareDatabase(settings('migration_concurrent')), prepareDatabase(settings('migration_concurrent'))]);
  assert.deepEqual(results.map(result => result.migrations[0]!.status).sort(), ['already_applied', 'applied']);
  const orm = connect('migration_concurrent');
  const rows = await orm.em.fork().execute<{ count: number }[]>('select count(*)::integer as count from public.yuna_schema_migrations');
  assert.equal(rows[0]?.count, 12);
}, 20_000);

test('PUBLIC privileges on unrelated data cause refusal without changing that data or its grants', async () => {
  await inspector.em.fork().execute('create database migration_unrelated');
  const orm = connect('migration_unrelated');
  await orm.em.fork().execute("create table public.unrelated(probe text); insert into public.unrelated values('keep'); grant select on public.unrelated to public");
  await assert.rejects(prepareDatabase(settings('migration_unrelated')), safePreparationError('unsafe_runtime_role'));
  assert.deepEqual(await orm.em.fork().execute('select probe from public.unrelated'), [{ probe: 'keep' }]);
  const grants = await orm.em.fork().execute<{ allowed: boolean }[]>("select has_table_privilege('yuna_worker','public.unrelated','SELECT') as allowed");
  assert.equal(grants[0]?.allowed, true);
  const ledger = await orm.em.fork().execute<{ ledger: string | null }[]>("select to_regclass('public.yuna_schema_migrations')::text as ledger");
  assert.equal(ledger[0]?.ledger, null);
});
