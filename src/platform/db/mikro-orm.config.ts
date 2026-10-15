import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { allEntities, coreEntities } from './entities.js';

/** Explicit configuration; it neither reads secrets nor connects/synchronizes on import. */
export function entityOrmConfig(options: { clientUrl?: string; includeStaged?: boolean } = {}) {
  return defineConfig({
    driver: PostgreSqlDriver,
    entities: options.includeStaged ? allEntities : coreEntities,
    dbName: 'yuna',
    ...(options.clientUrl ? { clientUrl: options.clientUrl } : {}),
    allowGlobalContext: false,
  });
}
