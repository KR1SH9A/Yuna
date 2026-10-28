/** Print the reviewed entity schema for inspection without applying it to a running database. */
import { MikroORM } from '@mikro-orm/postgresql';
import { entityOrmConfig } from './mikro-orm.config.js';
import { createEntitySchemaSql } from './schema-constraints.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--include-staged')) throw new Error('Usage: schema:sql [--include-staged]');
const orm = new MikroORM(entityOrmConfig({ includeStaged: args.includes('--include-staged') }));
try {
  // Metadata-only generation: printing SQL never applies it or connects to a database.
  process.stdout.write(await createEntitySchemaSql(orm));
} finally {
  await orm.close();
}
