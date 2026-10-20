import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';

// Explicit executable only: runtime bot/worker entrypoints never import or invoke setup.
try {
  if (process.argv.length > 2) throw new Error('Unsupported arguments');
  const result = await prepareDatabase({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL ?? '',
    botDatabasePassword: process.env.BOT_DATABASE_PASSWORD ?? '',
    workerDatabasePassword: process.env.WORKER_DATABASE_PASSWORD ?? '',
  });
  console.info(`Database prepared: ${result.migrations.map(migration => `${migration.version} ${migration.status}`).join(', ')}. Runtime roles: yuna_bot, yuna_worker.`);
} catch {
  console.error('Database preparation failed. Check admin ownership, runtime role safety, configuration and migration checksums.');
  process.exitCode = 1;
}
