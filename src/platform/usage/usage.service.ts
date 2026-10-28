/** Read and expire settled accounting; reservation, dispatch and settlement stay atomic in restricted SQL entry points. */
import type { EntityManager } from '@mikro-orm/postgresql';
import { invariant, assertUuid } from '../db/entity-values.js';
import type { ConversationTaskScope } from '../jobs/conversation-task.contracts.js';

export class UsageService {
  /** Retain every unresolved liability and every accounting row whose configured lifetime has not elapsed. */
  async purgeTaskAccounting(em: EntityManager, scope: ConversationTaskScope, taskId: string, now: Date): Promise<boolean> {
    invariant(em.isInTransaction(), 'Accounting cleanup requires the owner transaction');
    assertUuid(taskId);
    const rows = await em.execute<{ id: string; eligible: boolean }[]>(`select id,
      state in ('settled','released') and purge_after<=? and not exists(
        select 1 from usage_entry e where e.reservation_id=u.id and (e.purge_after>? or e.accounting_state not in ('actual','no-spend'))
      ) as eligible from usage_reservation u where installation_id=? and guild_id=? and task_id=? order by id for update`,
      [now, now, scope.installationId, scope.guildId, taskId]);
    if (rows.some(row => !row.eligible)) return false;
    for (const row of rows) {
      await em.execute('delete from usage_entry where installation_id=? and guild_id=? and reservation_id=?', [scope.installationId, scope.guildId, row.id]);
      await em.execute('delete from usage_reservation where installation_id=? and guild_id=? and id=?', [scope.installationId, scope.guildId, row.id]);
    }
    return true;
  }
}
