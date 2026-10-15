import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A private throwaway cluster: no existing database, credentials or TCP listener is used. */
export function temporaryPostgres() {
  const directory = mkdtempSync(join(tmpdir(), 'yuna-entities-'));
  const data = join(directory, 'data');
  const log = join(directory, 'postgres.log');
  let started = false;
  const run = (program: string, args: string[]) => execFileSync(program, args, { stdio: 'pipe', timeout: 30_000 });
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'yuna_test', '--no-locale', '-E', 'UTF8']);
    run('pg_ctl', ['-D', data, '-l', log, '-o', `-F -k ${directory} -c listen_addresses='' -p 55432`, '-w', 'start']);
    started = true;
  } catch (error) {
    let diagnostic = '';
    try { diagnostic = readFileSync(log, 'utf8'); } catch { /* initdb may fail before the log exists */ }
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Could not start isolated PostgreSQL; initdb and pg_ctl must be on PATH. ${diagnostic}`, { cause: error });
  }
  return {
    options: { host: directory, port: 55432, user: 'yuna_test', dbName: 'postgres' },
    applySchema(sql: string, databaseName = 'postgres') {
      // psql preserves PostgreSQL dollar-quoted function bodies and applies the DDL atomically.
      execFileSync('psql', ['-X', '-h', directory, '-p', '55432', '-U', 'yuna_test', '-d', databaseName, '-v', 'ON_ERROR_STOP=1', '-1', '-f', '-'], { input: sql, stdio: 'pipe', timeout: 30_000 });
    },
    close() {
      if (started) {
        run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
        started = false;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
