import { MikroORM, type Options } from '@mikro-orm/postgresql';
import type { BotRuntimeConfig, WorkerRuntimeConfig } from '../config/runtime-config.js';
import type { RuntimeResource } from '../runtime/application.js';

export interface DatabaseResource extends RuntimeResource {
  /** Access after successful startup; every entry point must use a fresh fork/context. */
  getOrm(): MikroORM;
}

/**
 * Own a role's database connection without creating a database, schema or migration. Allocation
 * starts only in start(); the application must call stop() even when start() fails partway.
 * The worker deliberately discovers no business entities until its restricted stores exist.
 */
export function createDatabaseResource(config: Pick<BotRuntimeConfig | WorkerRuntimeConfig, 'role' | 'databaseUrl'>): DatabaseResource {
  const { role, databaseUrl } = config;
  let orm: MikroORM | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stopped = false;
  let ready = false;

  return {
    name: 'database',
    getOrm() {
      if (!orm || !ready || stopped) throw new Error('Database is not ready');
      return orm;
    },
    start(signal) {
      if (stopped) return Promise.reject(new Error('Database resource has already stopped'));
      starting ??= (async () => {
        try {
          signal.throwIfAborted();
          const metadata: Options = role === 'bot'
            ? (await import('./mikro-orm.config.js')).entityOrmConfig({ clientUrl: databaseUrl })
            : { entities: [], discovery: { warnWhenNoEntities: false } };
          signal.throwIfAborted();
          const url = new URL(databaseUrl);
          // An omitted port must not silently redirect this role through an ambient PGPORT.
          if (!url.port) url.port = '5432';
          orm = new MikroORM({
            ...metadata,
            clientUrl: url.href,
            dbName: decodeURIComponent(url.pathname.slice(1)),
            host: decodeURIComponent(url.hostname).replace(/^\[(.*)\]$/, '$1'),
            port: Number(url.port),
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            schema: url.searchParams.get('schema') ?? 'public',
            entitiesTs: [],
            preferEnvVars: false,
            ensureDatabase: false,
            ensureIndexes: false,
            allowGlobalContext: false,
            debug: false,
            // Preserve pg's SSL/socket URL options, which ORM URL decomposition does not copy.
            driverOptions: { connectionString: url.href, connectionTimeoutMillis: 5_000 },
            // Driver diagnostics may contain credentials or SQL; startup reports only safe errors.
            logger: () => {},
          });
          await orm.connect();
          // In MikroORM 7, connect initializes the lazy pool; a query proves server readiness.
          await orm.em.fork().execute('select 1', [], { signal });
          signal.throwIfAborted();
          ready = true;
        } catch {
          throw new Error(signal.aborted ? 'Database startup canceled' : 'Database startup failed');
        }
      })();
      return starting;
    },
    stop() {
      stopped = true;
      ready = false;
      stopping ??= (async () => {
        // Do not close the pool while a pending startup can still create or acquire it.
        await starting?.catch(() => {});
        try {
          await orm?.close(true);
        } catch {
          throw new Error('Database shutdown failed');
        }
      })();
      return stopping;
    },
  };
}
