/** Build the entity metadata configuration used by explicit schema preparation and the bot runtime. */
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { allEntities, coreEntities } from './entities.js';

/** Explicit configuration; it neither reads secrets nor connects/synchronizes on import. */
export function entityOrmConfig(options: { clientUrl?: string; includeStaged?: boolean } = {}) {
  return defineConfig({
    driver: PostgreSqlDriver,
    entities: options.includeStaged ? allEntities : coreEntities,
    // An explicit dbName takes precedence over clientUrl in MikroORM. Keep the default only
    // for metadata/schema tooling so a runtime URL can select its actual database.
    ...(options.clientUrl ? { clientUrl: options.clientUrl } : { dbName: 'yuna' }),
    allowGlobalContext: false,
  });
}
