/** Cross-row integrity for Memory, Debates and optional governance/indexing; emit only constraints whose tables are present. */
export function stagedConstraintSql(tables: ReadonlySet<string>): string {
  const sql: string[] = [];
  /** Emit optional cross-table constraints only when every participating feature table is registered. */
  const has = (...names: string[]): boolean => names.every(name => tables.has(name));

  if (has('action_plan', 'plan_approval')) {
    sql.push(`
alter table action_plan add constraint plan_hash_identity unique (installation_id, guild_id, id, plan_hash);
alter table plan_approval add constraint approval_exact_plan_fk
  foreign key (installation_id, guild_id, plan_id, plan_hash)
  references action_plan (installation_id, guild_id, id, plan_hash)
  on delete no action deferrable initially deferred;
create function yuna_validate_approval_expiry() returns trigger language plpgsql as $$
begin
  if exists (select 1 from action_plan p where p.id = NEW.plan_id and NEW.expires_at > p.expires_at) then
    raise exception 'Approval cannot outlive the exact plan' using errcode = '23514';
  end if;
  return NEW;
end $$;
create constraint trigger approval_expiry_guard after insert or update on plan_approval
  deferrable initially deferred for each row execute function yuna_validate_approval_expiry();
`);
  }

  if (has('memory_scope', 'memory_fact')) {
    sql.push(`
alter table memory_scope add constraint memory_subject_identity unique (installation_id, guild_id, id, user_id);
alter table memory_fact add constraint memory_fact_exact_subject_fk
  foreign key (installation_id, guild_id, scope_id, subject_user_id)
  references memory_scope (installation_id, guild_id, id, user_id)
  on delete no action deferrable initially deferred;
`);
  }
  if (has('memory_fact', 'fact_embedding')) {
    sql.push(`
alter table memory_fact add constraint memory_fact_content_identity unique (installation_id, guild_id, id, content_hash);
alter table fact_embedding add constraint embedding_exact_content_fk
  foreign key (installation_id, guild_id, fact_id, content_hash)
  references memory_fact (installation_id, guild_id, id, content_hash)
  on delete no action deferrable initially deferred;
create function yuna_validate_embedding_retention() returns trigger language plpgsql as $$
begin
  if exists (select 1 from memory_fact f where f.id = NEW.fact_id and NEW.created_at >= f.expires_at) then
    raise exception 'An embedding cannot be accepted after its fact expires' using errcode = '23514';
  end if;
  return NEW;
end $$;
create constraint trigger embedding_retention_guard after insert or update on fact_embedding
  deferrable initially deferred for each row execute function yuna_validate_embedding_retention();
`);
  }

  if (has('debate_session', 'participant_consent')) {
    sql.push(`
alter table debate_session add constraint debate_consent_identity unique (installation_id, guild_id, id, scope_revision);
alter table participant_consent add constraint participant_exact_scope_fk
  foreign key (installation_id, guild_id, session_id, scope_revision)
  references debate_session (installation_id, guild_id, id, scope_revision)
  on delete no action deferrable initially deferred;
`);
  }
  if (has('debate_session', 'transcript_snapshot')) {
    sql.push(`
alter table transcript_snapshot add constraint snapshot_session_identity unique (installation_id, guild_id, session_id, id);
alter table debate_session add constraint debate_frozen_session_fk
  foreign key (installation_id, guild_id, id, frozen_transcript_id)
  references transcript_snapshot (installation_id, guild_id, session_id, id)
  on delete no action deferrable initially deferred;
`);
  }
  if (has('transcript_snapshot', 'transcript_entry')) {
    sql.push(`
create function yuna_validate_snapshot_entries() returns trigger language plpgsql as $$
begin
  if NEW.payload_purged_at is not null then return NEW; end if;
  if exists (
    select 1 from jsonb_array_elements_text(NEW.ordered_entry_ids) item(entry_id)
    left join transcript_entry e on e.id = item.entry_id::uuid
      and e.installation_id = NEW.installation_id and e.guild_id = NEW.guild_id and e.session_id = NEW.session_id
    where e.id is null or e.payload_purged_at is not null or e.purge_after < NEW.purge_after
  ) then
    raise exception 'Frozen entries must match the session and cover snapshot retention' using errcode = '23514';
  end if;
  return NEW;
end $$;
create constraint trigger snapshot_entry_scope_guard after insert or update on transcript_snapshot
  deferrable initially deferred for each row execute function yuna_validate_snapshot_entries();
`);
  }
  if (has('debate_session', 'transcript_snapshot', 'debate_evaluation')) {
    sql.push(`
alter table debate_session add constraint debate_frozen_identity
  unique (installation_id, guild_id, id, frozen_transcript_id, rubric_revision_id);
alter table debate_evaluation add constraint evaluation_exact_frozen_session_fk
  foreign key (installation_id, guild_id, session_id, transcript_snapshot_id, rubric_revision_id)
  references debate_session (installation_id, guild_id, id, frozen_transcript_id, rubric_revision_id)
  on delete no action deferrable initially deferred;
alter table debate_evaluation add constraint evaluation_snapshot_session_fk
  foreign key (installation_id, guild_id, session_id, transcript_snapshot_id)
  references transcript_snapshot (installation_id, guild_id, session_id, id)
  on delete no action deferrable initially deferred;
alter table debate_evaluation add constraint evaluation_session_identity
  unique (installation_id, guild_id, session_id, transcript_snapshot_id, rubric_revision_id, id);
alter table debate_session add constraint session_accepted_evaluation_fk
  foreign key (installation_id, guild_id, id, frozen_transcript_id, rubric_revision_id, accepted_evaluation_id)
  references debate_evaluation (installation_id, guild_id, session_id, transcript_snapshot_id, rubric_revision_id, id)
  on delete no action deferrable initially deferred;
`);
  }
  if (has('debate_session', 'transcript_snapshot', 'rubric_revision', 'debate_evaluation')) {
    sql.push(`
create function yuna_validate_evaluation_retention() returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from debate_session s, transcript_snapshot t, rubric_revision r
    where s.id = NEW.session_id and t.id = NEW.transcript_snapshot_id and r.id = NEW.rubric_revision_id
      and (NEW.purge_after > s.purge_after or NEW.purge_after > t.purge_after or NEW.purge_after > r.purge_after)
  ) then
    raise exception 'Evaluation cannot extend its session, transcript or rubric retention' using errcode = '23514';
  end if;
  return NEW;
end $$;
create constraint trigger evaluation_retention_guard after insert or update on debate_evaluation
  deferrable initially deferred for each row execute function yuna_validate_evaluation_retention();
`);
  }

  return sql.join('\n');
}
