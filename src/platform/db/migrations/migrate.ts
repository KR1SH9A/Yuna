/** Apply reviewed versioned SQL as an administrator and verify the restricted bot and worker privileges. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';

export interface DatabasePreparationConfig {
  readonly adminDatabaseUrl: string;
  readonly botDatabasePassword: string;
  readonly workerDatabasePassword: string;
}
export interface DatabasePreparationResult {
  readonly database: string;
  readonly roles: readonly ['yuna_bot', 'yuna_worker'];
  readonly migrations: readonly Readonly<{ version: number; name: string; status: 'applied' | 'already_applied' }>[];
}
type PreparationErrorCode = 'invalid_configuration' | 'unsafe_administrator' | 'unsafe_runtime_role' | 'migration_mismatch' | 'preparation_failed';

/** Do not retain driver errors: SQL, connection strings and role passwords can appear in them. */
export class DatabasePreparationError extends Error {
  /** Report only an allowlisted preparation error code, keeping driver details and credentials private. */
  constructor(readonly code: PreparationErrorCode) {
    super(`Database preparation failed (${code})`);
    this.name = 'DatabasePreparationError';
  }
}

const roles = ['yuna_bot', 'yuna_worker'] as const;
const enabledTables = ['guild_installation', 'guild_safety_state', 'capability_grant', 'audit_entry', 'usage_policy', 'user_usage_limit', 'channel_reply_settings', 'knowledge_entry',
  'memory_scope', 'memory_fact', 'memory_deletion_request', 'debate_session', 'participant_consent', 'transcript_entry', 'transcript_snapshot', 'rubric_revision', 'debate_evaluation',
  'moderation_case', 'moderation_policy_revision', 'evidence_revision', 'moderation_finding', 'moderation_action', 'moderation_action_finding', 'action_attempt', 'target_execution_state',
  'intake_event', 'intake_delivery', 'conversation_request', 'reply_delivery', 'ai_task', 'prepared_input',
  'task_attempt', 'task_result', 'task_acceptance', 'outbox_entry', 'usage_reservation', 'usage_entry', 'channel_chore'];

/** Load reviewed SQL beside source, or from the repository when running emitted dist JavaScript. */
async function readMigration(name: string): Promise<string> {
  try { return await readFile(new URL(`./${name}`, import.meta.url), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readFile(new URL(`../../../../../src/platform/db/migrations/${name}`, import.meta.url), 'utf8');
  }
}

/** Use only explicit admin settings; runtime roles must never own their own schema or migrations. */
function validateConfiguration(config: DatabasePreparationConfig): URL {
  try {
    const url = new URL(config.adminDatabaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username
      || url.pathname.length < 2 || url.pathname.slice(1).includes('/') || url.hash
      || /[\s\p{Cc}]/u.test(config.adminDatabaseUrl)) throw new Error();
    for (const value of [url.hostname, url.username, url.password, url.pathname]) decodeURIComponent(value);
    if (roles.includes(decodeURIComponent(url.username) as typeof roles[number])) throw new Error();
    for (const password of [config.botDatabasePassword, config.workerDatabasePassword]) {
      if (typeof password !== 'string' || password.length === 0 || password.length > 4_096 || password.includes('\0')) throw new Error();
    }
    if (!url.port) url.port = '5432';
    return url;
  } catch { throw new DatabasePreparationError('invalid_configuration'); }
}

/** Fixed cluster roles are reusable only when they have no elevated flags, memberships or ownership. */
async function prepareRole(em: EntityManager, role: typeof roles[number], password: string): Promise<void> {
  const existing = await em.execute<{ oid: number; unsafe: boolean }[]>(`
    select r.oid, (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls or r.rolinherit
      or exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid or m.roleid=r.oid)
      or exists(select 1 from pg_catalog.pg_shdepend d where d.refclassid='pg_catalog.pg_authid'::regclass and d.refobjid=r.oid and d.deptype='o')) as unsafe
    from pg_catalog.pg_roles r where r.rolname=?`, [role]);
  if (existing[0]?.unsafe) throw new DatabasePreparationError('unsafe_runtime_role');
  if (!existing.length) await em.execute(`create role ${role} login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
  // PostgreSQL quotes the secret as a literal; it is never concatenated in its raw form or logged.
  const quoted = await em.execute<{ value: string }[]>('select pg_catalog.quote_literal(?) as value', [password]);
  await em.execute(`alter role ${role} login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password ${quoted[0]!.value}`);
}

/** Refuse inherited PUBLIC/column grants on unrelated objects rather than altering those objects. */
async function verifyRuntimePrivileges(em: EntityManager, administrator: string, coreFunctions: readonly string[]): Promise<void> {
  const tables = await em.execute<{ role: string; table_name: string; schema_name: string; table_access: boolean; column_access: boolean }[]>(`
    select r.rolname as role, c.relname as table_name, n.nspname as schema_name,
      pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as table_access,
      exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
        and pg_catalog.has_column_privilege(r.oid,c.oid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')) as column_access
    from pg_catalog.pg_roles r cross join pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where r.rolname in ('yuna_bot','yuna_worker') and c.relkind in ('r','p','v','m','f')
      and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%'`);
  for (const row of tables) {
    const permitted = row.role === 'yuna_bot' && row.schema_name === 'public' && enabledTables.includes(row.table_name);
    if (!permitted && (row.table_access || row.column_access)) throw new DatabasePreparationError('unsafe_runtime_role');
  }
  const sequences = await em.execute<{ unsafe: boolean }[]>(`
    select exists(select 1 from pg_catalog.pg_roles r cross join pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace where r.rolname in ('yuna_bot','yuna_worker') and c.relkind='S'
      and n.nspname not in ('pg_catalog','information_schema')
      and pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')) as unsafe`);
  if (sequences[0]?.unsafe) throw new DatabasePreparationError('unsafe_runtime_role');
  // Check existing function ownership/grants too: a checksum alone cannot detect privilege drift.
  const functions: [string, boolean, boolean][] = [
    ...coreFunctions.map(name => [`public.${name}()`, false, false] as [string, boolean, boolean]),
    ['public.yuna_conversation_gate(uuid)', false, false],
    ['public.yuna_conversation_terminal(uuid,text,text,jsonb,timestamptz)', false, false],
    ['public.yuna_conversation_account(uuid,jsonb,text,text,timestamptz)', false, false],
    ['public.yuna_conversation_claim(text,text)', false, true],
    ['public.yuna_conversation_release(uuid,uuid,integer,text)', false, true],
    ['public.yuna_conversation_start(uuid,uuid,integer,text)', false, true],
    ['public.yuna_conversation_finish(uuid,uuid,integer,text,jsonb)', false, true],
    ['public.yuna_conversation_recover(integer)', true, false],
    ['public.yuna_notify_tasks_ready()', false, false],
    ['public.yuna_notify_results_ready()', false, false],
    ['public.yuna_validate_snapshot_entries()', false, false],
    ['public.yuna_validate_evaluation_retention()', false, false],
    ['public.yuna_debate_gate(uuid)', false, false],
    ['public.yuna_debate_claim(text,text)', false, true],
    ['public.yuna_debate_release(uuid,uuid,integer,text)', false, true],
    ['public.yuna_debate_start(uuid,uuid,integer,text)', false, true],
    ['public.yuna_debate_finish(uuid,uuid,integer,text,jsonb)', false, true],
    ['public.yuna_debate_recover(integer)', true, false],
    ['public.yuna_knowledge_context_current(uuid)', false, false],
    ['public.yuna_chat_context_current(uuid)', false, false],
    ['public.yuna_usage_task_user(uuid)', false, false],
    ['public.yuna_usage_user_gate(uuid,numeric,text,boolean)', false, false],
    ['public.yuna_moderation_gate(uuid)', false, false],
    ['public.yuna_moderation_claim(text,text,text)', false, true],
    ['public.yuna_moderation_release(uuid,uuid,integer,text)', false, true],
    ['public.yuna_moderation_start(uuid,uuid,integer,text)', false, true],
    ['public.yuna_moderation_finish(uuid,uuid,integer,text,jsonb)', false, true],
    ['public.yuna_moderation_recover(integer)', true, false],
  ];
  for (const [identity, bot, worker] of functions) {
    const rows = await em.execute<{ owner: string; bot: boolean; worker: boolean }[]>(`select pg_catalog.pg_get_userbyid(p.proowner) as owner,
      pg_catalog.has_function_privilege('yuna_bot',p.oid,'EXECUTE') as bot,
      pg_catalog.has_function_privilege('yuna_worker',p.oid,'EXECUTE') as worker
      from pg_catalog.pg_proc p where p.oid=?::regprocedure`, [identity]);
    if (rows[0]?.owner !== administrator) throw new DatabasePreparationError('unsafe_administrator');
    if (rows[0].bot !== bot || rows[0].worker !== worker) throw new DatabasePreparationError('unsafe_runtime_role');
  }
}

/**
 * Explicit administrative operation only. An advisory lock serializes this database's setup;
 * role changes, migrations, checksums and grants commit together or roll back together.
 * Existing unrelated objects are untouched. PUBLIC CREATE on public is deliberately revoked.
 */
export async function prepareDatabase(config: DatabasePreparationConfig): Promise<DatabasePreparationResult> {
  const url = validateConfiguration(config);
  let orm: MikroORM | undefined;
  try {
    const names = ['001-core.sql', 'conversation-worker.sql', '003-conversation-notifications.sql', '004-operating-controls.sql', '005-moderation-worker.sql', '006-user-quotas.sql', '007-knowledge-context.sql', '008-memory.sql', '009-debates.sql', '010-chat-context.sql', '011-channel-chores.sql', '012-admin-planning.sql'];
    const migrations = await Promise.all(names.map(async (name, index) => {
      const sql = await readMigration(name);
      return { version: index + 1, name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }));
    const coreTables = [...migrations[0]!.sql.matchAll(/^create table "([a-z_]+)"/gm)].map(match => match[1]!);
    const coreFunctions = [...migrations[0]!.sql.matchAll(/^create function (yuna_[a-z_]+)\(\)/gm)].map(match => match[1]!);
    if (coreTables.length !== 28 || coreFunctions.length === 0) throw new DatabasePreparationError('migration_mismatch');
    orm = new MikroORM({
      entities: [], entitiesTs: [], discovery: { warnWhenNoEntities: false },
      clientUrl: url.href, dbName: decodeURIComponent(url.pathname.slice(1)),
      host: decodeURIComponent(url.hostname).replace(/^\[(.*)\]$/, '$1'), port: Number(url.port),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema: 'public',
      preferEnvVars: false, ensureDatabase: false, ensureIndexes: false, debug: false, logger: () => {},
      driverOptions: { connectionString: url.href, connectionTimeoutMillis: 5_000 },
    });
    await orm.connect();
    return await orm.em.fork().transactional(async em => {
      await em.execute("set local lock_timeout='10s'; set local statement_timeout='60s'; set local search_path=public,pg_catalog");
      await em.execute('select pg_catalog.pg_advisory_xact_lock(715723,1)');
      const identity = await em.execute<{ database: string; administrator: string; owner: string; original_user: string }[]>(`
        select pg_catalog.current_database() as database, current_user as administrator, session_user as original_user,
          pg_catalog.pg_get_userbyid(d.datdba) as owner from pg_catalog.pg_database d where d.datname=pg_catalog.current_database()`);
      const selected = identity[0]!;
      if (selected.administrator !== selected.owner || selected.administrator !== selected.original_user
        || roles.includes(selected.administrator as typeof roles[number])) throw new DatabasePreparationError('unsafe_administrator');
      await prepareRole(em, 'yuna_bot', config.botDatabasePassword);
      await prepareRole(em, 'yuna_worker', config.workerDatabasePassword);
      await em.execute('revoke create on schema public from public,yuna_bot,yuna_worker');
      await em.execute(`create table if not exists public.yuna_schema_migrations (
        version integer primary key, name text not null unique, checksum text not null check(checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz not null default now())`);
      const ledgerOwner = await em.execute<{ owner: string }[]>(`select pg_catalog.pg_get_userbyid(relowner) as owner
        from pg_catalog.pg_class where oid='public.yuna_schema_migrations'::regclass`);
      if (ledgerOwner[0]?.owner !== selected.administrator) throw new DatabasePreparationError('unsafe_administrator');
      const applied = await em.execute<{ version: number; name: string; checksum: string }[]>(
        'select version,name,checksum from public.yuna_schema_migrations order by version');
      for (let index = 0; index < applied.length; index++) {
        const actual = applied[index]!, expected = migrations[index];
        if (!expected || actual.version !== expected.version || actual.name !== expected.name || actual.checksum !== expected.checksum) {
          throw new DatabasePreparationError('migration_mismatch');
        }
      }
      const status: { version: number; name: string; status: 'applied' | 'already_applied' }[] = [];
      for (const migration of migrations) {
        const exists = applied.some(row => row.version === migration.version);
        if (!exists) {
          // The driver sends the complete SQL batch, preserving dollar-quoted PL/pgSQL bodies.
          await em.execute(migration.sql);
          await em.execute('insert into public.yuna_schema_migrations(version,name,checksum) values(?,?,?)',
            [migration.version, migration.name, migration.checksum]);
        }
        status.push(Object.freeze({ version: migration.version, name: migration.name, status: exists ? 'already_applied' : 'applied' }));
      }
      const ownership = await em.execute<{ name: string; owner: string }[]>(`select c.relname as name,
        pg_catalog.pg_get_userbyid(c.relowner) as owner from pg_catalog.pg_class c join pg_catalog.pg_namespace n
        on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`);
      for (const table of [...coreTables, 'user_usage_limit', 'memory_scope', 'memory_fact', 'memory_deletion_request', 'debate_session', 'participant_consent', 'transcript_entry', 'transcript_snapshot', 'rubric_revision', 'debate_evaluation', 'channel_chore', 'yuna_schema_migrations']) {
        if (ownership.find(row => row.name === table)?.owner !== selected.administrator) throw new DatabasePreparationError('unsafe_administrator');
        await em.execute(`revoke all on table public."${table}" from public,yuna_bot,yuna_worker`);
      }
      for (const name of [...coreFunctions, 'yuna_validate_snapshot_entries', 'yuna_validate_evaluation_retention']) await em.execute(`revoke all on function public.${name}() from public,yuna_bot,yuna_worker`);
      await em.execute('grant usage on schema public to yuna_bot,yuna_worker');
      const databaseName = await em.execute<{ value: string }[]>('select pg_catalog.quote_ident(pg_catalog.current_database()) as value');
      await em.execute(`grant connect on database ${databaseName[0]!.value} to yuna_bot,yuna_worker`);
      for (const table of enabledTables) await em.execute(`grant select,insert,update,delete on table public."${table}" to yuna_bot`);
      await verifyRuntimePrivileges(em, selected.administrator, coreFunctions);
      return Object.freeze({ database: selected.database, roles: Object.freeze(roles), migrations: Object.freeze(status) });
    });
  } catch (error) {
    if (error instanceof DatabasePreparationError) throw error;
    throw new DatabasePreparationError('preparation_failed');
  } finally {
    try { await orm?.close(true); } catch { throw new DatabasePreparationError('preparation_failed'); }
  }
}
