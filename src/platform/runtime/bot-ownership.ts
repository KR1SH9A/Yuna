/** Hold one PostgreSQL session lock per configured guild, fencing duplicate bot runtimes before Discord starts. */
import type { EventEmitter } from 'node:events';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { RuntimeResource } from './application.js';
import { assertDiscordId } from '../db/entity-values.js';

type LockClient = Pick<EventEmitter, 'on' | 'removeListener'> & {
  query(sql: string, values?: unknown[]): Promise<{ rows: { acquired?: boolean }[] }>;
  release(destroy: boolean): void;
};
interface LockPool { connect(): Promise<LockClient> }

/** Session loss fails closed; a fresh process must repeat normal installation recovery before it can act. */
export function createBotOwnership(getOrm: () => MikroORM, guildId: string, lost: () => void): RuntimeResource {
  assertDiscordId(guildId);
  let client: LockClient | undefined;
  let stopped = false, failed = false;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let resolveFailure!: () => void;
  const failure = new Promise<void>(resolve => { resolveFailure = resolve; });
  /** Notify composition once; driver errors may contain secrets and are never propagated. */
  const onLoss = () => {
    if (stopped || failed) return;
    failed = true;
    clearTimeout(heartbeat);
    clearTimeout(watchdog);
    resolveFailure();
    try { lost(); } catch { /* Runtime failure still aborts resources and reaches the supervised process. */ }
  };
  /** A client-side deadline detects silent network stalls as well as rejected heartbeat queries. */
  const check = async () => {
    if (stopped || failed) return;
    watchdog = setTimeout(onLoss, 5_000);
    try {
      await client!.query('select 1');
      if (!stopped && !failed) heartbeat = setTimeout(() => { void check(); }, 5_000);
    } catch { onLoss(); }
    finally { clearTimeout(watchdog); }
  };
  return {
    name: 'bot-ownership',
    failure,
    /** Acquire the dedicated PostgreSQL ownership lock so only one bot can drive this installation. */
    async start(signal) {
      signal.throwIfAborted();
      // Pool acquisition and setup also need a local deadline: server statement timeouts cannot detect a dead socket.
      watchdog = setTimeout(onLoss, 5_000);
      try {
        const pool = await getOrm().em.getConnection().getNativeClient() as LockPool;
        const acquired = await pool.connect();
        acquired.on('error', onLoss);
        if (stopped) { acquired.release(true); throw new Error(); }
        client = acquired;
        acquired.on('end', onLoss);
        if (failed || signal.aborted) throw new Error();
        await acquired.query("set statement_timeout='5000'");
        if (stopped || failed || signal.aborted) throw new Error();
        const result = await acquired.query('select pg_try_advisory_lock(hashtextextended($1,0)) as acquired', [`yuna:bot:${guildId}`]);
        if (!result.rows[0]?.acquired || stopped || failed || signal.aborted) throw new Error();
        heartbeat = setTimeout(() => { void check(); }, 5_000);
      } catch { throw new Error('Bot ownership unavailable; another bot may own this guild'); }
      finally { clearTimeout(watchdog); }
    },
    /** Destroy the dedicated lock session and stop heartbeats so ownership cannot leak back into the pool. */
    async stop() {
      stopped = true;
      clearTimeout(heartbeat);
      clearTimeout(watchdog);
      if (client) {
        // Destroying the dedicated session releases every session advisory lock and prevents pool reuse.
        client.removeListener('end', onLoss);
        client.release(true);
        client = undefined;
      }
    },
  };
}
