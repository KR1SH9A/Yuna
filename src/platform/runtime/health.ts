/** Read a content-free operational snapshot without taking ownership, sending Discord traffic or changing workflow state. */
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertDiscordId } from '../db/entity-values.js';

export interface HealthSnapshot {
  ready: boolean;
  installationState: string | null;
  discordAvailability: string | null;
  botOwnsGuild: boolean;
  paused: boolean;
  queuedTasks: number;
  runningTasks: number;
  expiredRunningTasks: number;
  unknownReplies: number;
  unknownActions: number;
  unresolvedCharges: number;
  observedAt: string;
}

/** A held ownership lock plus current availability establishes bot readiness; queue progress must still be monitored over time. */
export async function readHealthSnapshot(orm: MikroORM, guildId: string, signal: AbortSignal): Promise<HealthSnapshot> {
  assertDiscordId(guildId);
  const rows = await orm.em.fork().execute<{
    state: string | null; availability: string | null; owns: boolean; paused: boolean;
    queued: number; running: number; expired: number; unknown_replies: number; unknown_actions: number; unresolved: number; observed: Date;
  }[]>(`with selected as(select id,state,discord_availability from public.guild_installation where guild_id=? order by generation desc limit 1)
    select i.state,i.discord_availability as availability,coalesce(s.paused,true) as paused,
      exists(select 1 from pg_catalog.pg_locks where locktype='advisory' and granted and objsubid=1
        and database=(select oid from pg_catalog.pg_database where datname=current_database())
        and ((classid::bigint<<32)|objid::bigint)=hashtextextended('yuna:bot:'||?,0)) as owns,
      (select count(*)::integer from public.ai_task where installation_id=i.id and state='READY') as queued,
      (select count(*)::integer from public.ai_task where installation_id=i.id and state='RUNNING') as running,
      (select count(*)::integer from public.ai_task where installation_id=i.id and state='RUNNING' and deadline<clock_timestamp()) as expired,
      (select count(*)::integer from public.reply_delivery where installation_id=i.id and state='UNKNOWN') as unknown_replies,
      (select count(*)::integer from public.moderation_action where installation_id=i.id and state='UNKNOWN') as unknown_actions,
      (select count(*)::integer from public.usage_reservation where guild_id=? and state='liability') as unresolved,
      clock_timestamp() as observed
    from (values(1)) anchor(x) left join selected i on true left join public.guild_safety_state s on s.installation_id=i.id`,
  [guildId, guildId, guildId], { signal });
  const row = rows[0]!;
  return { ready: row.state === 'active' && row.availability === 'available' && row.owns && !row.paused,
    installationState: row.state, discordAvailability: row.availability, botOwnsGuild: row.owns, paused: row.paused,
    queuedTasks: row.queued, runningTasks: row.running, expiredRunningTasks: row.expired, unknownReplies: row.unknown_replies,
    unknownActions: row.unknown_actions, unresolvedCharges: row.unresolved, observedAt: new Date(row.observed).toISOString() };
}
