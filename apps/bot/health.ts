/** Print one bounded, read-only operational snapshot for a supervisor or operator; no tokens or source content are logged. */
import { loadHealthConfig } from '../../src/platform/config/runtime-config.js';
import { createDatabaseResource } from '../../src/platform/db/db.module.js';
import { readHealthSnapshot } from '../../src/platform/runtime/health.js';

let database: ReturnType<typeof createDatabaseResource> | undefined;
try {
  if (process.argv.length > 2) throw new Error('Unsupported health arguments');
  const config = loadHealthConfig(process.env);
  database = createDatabaseResource(config);
  const signal = AbortSignal.timeout(5_000);
  await database.start(signal);
  const snapshot = await readHealthSnapshot(database.getOrm(), config.guildId, signal);
  console.info(JSON.stringify(snapshot));
  if (!snapshot.ready) process.exitCode = 1;
} catch {
  console.error('Yuna health check unavailable; verify database connectivity, schema and guild configuration.');
  process.exitCode = 1;
} finally {
  try { await database?.stop(); } catch { process.exitCode = 1; }
}
