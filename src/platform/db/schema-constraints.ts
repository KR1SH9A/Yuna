import type { MikroORM } from '@mikro-orm/postgresql';
import { moderationConstraintSql } from './moderation-constraints.js';
import { jobConstraintSql } from './job-constraints.js';
import { stagedConstraintSql } from './staged-constraints.js';

/**
 * Scalar IDs keep ORM entity graphs inside their features. These database constraints enforce
 * cross-feature ownership without importing another context's entities into business code.
 * Apply only as part of a reviewed migration/test schema, never from application startup.
 */
const scopedReferences: ReadonlyArray<readonly [string, string, string]> = [
  ['intake_delivery', 'event_id', 'intake_event'],
  ['moderation_case', 'original_event_id', 'intake_event'],
  ['moderation_case', 'policy_revision_id', 'moderation_policy_revision'],
  ['moderation_case', 'expected_task_id', 'ai_task'],
  ['evidence_revision', 'case_id', 'moderation_case'],
  ['evidence_revision', 'original_event_id', 'intake_event'],
  ['evidence_revision', 'supersedes_evidence_id', 'evidence_revision'],
  ['moderation_finding', 'case_id', 'moderation_case'],
  ['moderation_finding', 'policy_revision_id', 'moderation_policy_revision'],
  ['moderation_finding', 'observation_task_result_id', 'task_result'],
  ['moderation_finding', 'assessment_task_result_id', 'task_result'],
  ['moderation_action', 'case_id', 'moderation_case'],
  ['moderation_action', 'policy_revision_id', 'moderation_policy_revision'],
  ['action_attempt', 'action_id', 'moderation_action'],
  ['conversation_request', 'expected_task_id', 'ai_task'],
  ['conversation_request', 'accepted_result_reference', 'task_result'],
  ['knowledge_entry', 'replacement_entry_id', 'knowledge_entry'],
  ['reply_delivery', 'request_id', 'conversation_request'],
  ['reply_delivery', 'accepted_result_reference', 'task_result'],
  ['ai_task', 'prepared_input_id', 'prepared_input'],
  ['ai_task', 'active_attempt_id', 'task_attempt'],
  ['prepared_input', 'task_id', 'ai_task'],
  ['prepared_input', 'source_event_id', 'intake_event'],
  ['prepared_input', 'policy_revision_id', 'moderation_policy_revision'],
  ['prepared_input', 'privacy_scope_id', 'memory_scope'],
  ['task_attempt', 'task_id', 'ai_task'],
  ['task_attempt', 'reservation_id', 'usage_reservation'],
  ['task_result', 'task_id', 'ai_task'],
  ['task_result', 'attempt_id', 'task_attempt'],
  ['task_result', 'usage_reservation_id', 'usage_reservation'],
  ['task_acceptance', 'task_id', 'ai_task'],
  ['task_acceptance', 'result_id', 'task_result'],
  ['usage_reservation', 'task_id', 'ai_task'],
  ['usage_reservation', 'attempt_id', 'task_attempt'],
  ['usage_reservation', 'usage_policy_id', 'usage_policy'],
  ['usage_entry', 'reservation_id', 'usage_reservation'],
  ['usage_entry', 'attempt_id', 'task_attempt'],
  ['plan_approval', 'plan_id', 'action_plan'],
  ['custodian_enrollment', 'plan_id', 'action_plan'],
  ['custodian_enrollment', 'resulting_grant_id', 'capability_grant'],
  ['memory_fact', 'scope_id', 'memory_scope'],
  ['memory_fact', 'accepted_task_result_id', 'task_result'],
  ['fact_embedding', 'fact_id', 'memory_fact'],
  ['fact_embedding', 'accepted_task_result_id', 'task_result'],
  ['memory_deletion_request', 'scope_id', 'memory_scope'],
  ['debate_session', 'rubric_revision_id', 'rubric_revision'],
  ['debate_session', 'frozen_transcript_id', 'transcript_snapshot'],
  ['debate_session', 'accepted_evaluation_id', 'debate_evaluation'],
  ['participant_consent', 'session_id', 'debate_session'],
  ['transcript_entry', 'session_id', 'debate_session'],
  ['transcript_snapshot', 'session_id', 'debate_session'],
  ['debate_evaluation', 'session_id', 'debate_session'],
  ['debate_evaluation', 'transcript_snapshot_id', 'transcript_snapshot'],
  ['debate_evaluation', 'rubric_revision_id', 'rubric_revision'],
];

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const columns = (names: string[]): string => names.map(quote).join(', ');

export function entityConstraintSql(orm: MikroORM): string {
  const tables = new Map([...orm.getMetadata().getAll().values()]
    .filter(meta => !meta.abstract && !!meta.tableName)
    .map(meta => [meta.tableName, new Set(meta.props.flatMap(property => property.fieldNames))]));
  const sql: string[] = [];
  const fk = (table: string, name: string, fields: string[], parent: string, target: string[]) => {
    sql.push(`alter table ${quote(table)} add constraint ${quote(name)} foreign key (${columns(fields)}) references ${quote(parent)} (${columns(target)}) on delete no action deferrable initially deferred;`);
  };
  for (const [table, fields] of tables) {
    if (fields.has('installation_id') && fields.has('guild_id')) {
      fk(table, `${table}_installation_scope_fk`, ['installation_id', 'guild_id'], 'guild_installation', ['id', 'guild_id']);
    }
    // Constructors reject invalid IDs too; SQL writes cannot bypass their storage representation.
    for (const field of ['guild_id', 'target_user_id', 'subject_user_id', 'source_channel_id', 'source_message_id', 'author_user_id', 'original_author_user_id']) {
      if (fields.has(field)) sql.push(`alter table ${quote(table)} add constraint ${quote(`${table}_${field}_snowflake`)} check (${quote(field)} is null or (${quote(field)} ~ '^[1-9][0-9]{0,19}$' and ${quote(field)}::numeric <= 18446744073709551615));`);
    }
  }
  for (const [table, field, parent] of scopedReferences) {
    if (!tables.has(table)) continue;
    if (!tables.get(table)!.has(field)) throw new Error(`Missing mapped field ${table}.${field}`);
    if (!tables.has(parent)) {
      sql.push(`alter table ${quote(table)} add constraint ${quote(`${table}_${field}_disabled`)} check (${quote(field)} is null);`);
      continue;
    }
    fk(table, `${table}_${field}_scope_fk`, ['installation_id', 'guild_id', field], parent, ['installation_id', 'guild_id', 'id']);
  }
  sql.push('alter table evidence_revision add constraint evidence_case_identity unique (installation_id, guild_id, case_id, id);');
  fk('moderation_case', 'moderation_case_current_evidence_fk', ['installation_id', 'guild_id', 'id', 'current_evidence_revision_id'], 'evidence_revision', ['installation_id', 'guild_id', 'case_id', 'id']);
  for (const table of ['moderation_finding', 'moderation_action']) {
    fk(table, `${table}_exact_evidence_fk`, ['installation_id', 'guild_id', 'case_id', 'evidence_revision_id'], 'evidence_revision', ['installation_id', 'guild_id', 'case_id', 'id']);
  }
  sql.push('alter table action_attempt add constraint action_attempt_owner_identity unique (installation_id, guild_id, action_id, id);');
  fk('moderation_action', 'moderation_action_active_attempt_fk', ['installation_id', 'guild_id', 'id', 'active_attempt_id'], 'action_attempt', ['installation_id', 'guild_id', 'action_id', 'id']);
  sql.push('alter table moderation_action add constraint moderation_action_target_identity unique (installation_id, guild_id, target_user_id, id);');
  fk('target_execution_state', 'target_execution_state_action_fk', ['unresolved_installation_id', 'guild_id', 'target_user_id', 'unresolved_action_id'], 'moderation_action', ['installation_id', 'guild_id', 'target_user_id', 'id']);
  sql.push('alter table target_execution_state add constraint target_unresolved_pair check ((unresolved_action_id is null) = (unresolved_installation_id is null));');
  sql.push('alter table conversation_request add constraint conversation_accepted_result_identity unique (installation_id, guild_id, id, accepted_result_reference);');
  fk('reply_delivery', 'reply_delivery_accepted_result_fk', ['installation_id', 'guild_id', 'request_id', 'accepted_result_reference'], 'conversation_request', ['installation_id', 'guild_id', 'id', 'accepted_result_reference']);

  sql.push(moderationConstraintSql(), jobConstraintSql(), stagedConstraintSql(new Set(tables.keys())));
  return sql.join('\n');
}

/** Generate a reviewable complete initial schema, including explicit scalar-ID constraints. */
export async function createEntitySchemaSql(orm: MikroORM): Promise<string> {
  return `${await orm.schema.getCreateSchemaSQL({ wrap: false })}\n${entityConstraintSql(orm)}`;
}
