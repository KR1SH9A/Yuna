/**
 * Relationships that cannot be established by an entity constructor or a row CHECK.
 * Deferred keys let registration/claim/finalization persist all participating rows atomically.
 * The installation-scoped parent keys themselves are supplied by entityConstraintSql.
 */
export function jobConstraintSql(): string {
  return `
-- A task's chosen input must name that same task. The existing unique task_id on
-- prepared_input and required references in both directions make the pairing reciprocal.
alter table prepared_input add constraint prepared_input_task_identity
  unique (installation_id, guild_id, task_id, id);
alter table ai_task add constraint ai_task_exact_input_fk
  foreign key (installation_id, guild_id, id, prepared_input_id)
  references prepared_input (installation_id, guild_id, task_id, id)
  on delete no action deferrable initially deferred;

-- An active attempt and terminal result cannot borrow another task's attempt or generation.
alter table task_attempt add constraint task_attempt_execution_identity
  unique (installation_id, guild_id, task_id, id, generation);
alter table ai_task add constraint ai_task_exact_active_attempt_fk
  foreign key (installation_id, guild_id, id, active_attempt_id, execution_generation)
  references task_attempt (installation_id, guild_id, task_id, id, generation)
  on delete no action deferrable initially deferred;
alter table task_result add constraint task_result_exact_attempt_fk
  foreign key (installation_id, guild_id, task_id, attempt_id, attempt_generation)
  references task_attempt (installation_id, guild_id, task_id, id, generation)
  on delete no action deferrable initially deferred;
alter table task_result add constraint task_result_task_identity
  unique (installation_id, guild_id, task_id, id);
alter table task_acceptance add constraint task_acceptance_exact_result_fk
  foreign key (installation_id, guild_id, task_id, result_id)
  references task_result (installation_id, guild_id, task_id, id)
  on delete no action deferrable initially deferred;

-- Before claim a reservation has no attempt_id. Once either side is claimed, both
-- references must identify the same task/attempt slot and accounted opportunity.
alter table usage_reservation add constraint usage_reservation_attempt_identity
  unique (installation_id, guild_id, task_id, attempt_number, id, attempt_id);
alter table task_attempt add constraint task_attempt_reservation_identity
  unique (installation_id, guild_id, task_id, attempt_number, reservation_id, id);
alter table task_attempt add constraint task_attempt_exact_reservation_fk
  foreign key (installation_id, guild_id, task_id, attempt_number, reservation_id, id)
  references usage_reservation (installation_id, guild_id, task_id, attempt_number, id, attempt_id)
  on delete no action deferrable initially deferred;
alter table usage_reservation add constraint usage_reservation_exact_attempt_fk
  foreign key (installation_id, guild_id, task_id, attempt_number, id, attempt_id)
  references task_attempt (installation_id, guild_id, task_id, attempt_number, reservation_id, id)
  on delete no action deferrable initially deferred;
alter table task_attempt add constraint task_attempt_usage_identity
  unique (installation_id, guild_id, task_id, id, reservation_id);
alter table task_result add constraint task_result_exact_usage_fk
  foreign key (installation_id, guild_id, task_id, attempt_id, usage_reservation_id)
  references task_attempt (installation_id, guild_id, task_id, id, reservation_id)
  on delete no action deferrable initially deferred;
alter table usage_reservation add constraint usage_reservation_claim_identity
  unique (installation_id, guild_id, id, attempt_id);
alter table usage_entry add constraint usage_entry_exact_attempt_fk
  foreign key (installation_id, guild_id, reservation_id, attempt_id)
  references usage_reservation (installation_id, guild_id, id, attempt_id)
  on delete no action deferrable initially deferred;
alter table usage_reservation add constraint usage_reservation_operation_identity
  unique (installation_id, guild_id, id, operation_kind, operation_key);
alter table usage_entry add constraint usage_entry_exact_operation_fk
  foreign key (installation_id, guild_id, reservation_id, operation_kind, operation_key)
  references usage_reservation (installation_id, guild_id, id, operation_kind, operation_key)
  on delete no action deferrable initially deferred;

-- Re-read committed transaction state: insert order is unrestricted, but a result
-- cannot be left on unfinished work or removed while its terminal task survives.
create function yuna_validate_task_execution() returns trigger language plpgsql as $$
declare
  old_task_id uuid;
  new_task_id uuid;
  task_key uuid;
  task_row ai_task;
  result_row task_result;
  attempt_row task_attempt;
  has_result boolean;
begin
  if TG_TABLE_NAME = 'ai_task' then
    if TG_OP <> 'INSERT' then old_task_id := OLD.id; end if;
    if TG_OP <> 'DELETE' then new_task_id := NEW.id; end if;
    if TG_OP = 'UPDATE' and OLD.state = 'TERMINAL' and NEW.state <> 'TERMINAL' then
      raise exception 'Terminal tasks cannot reopen' using errcode = '23514';
    end if;
  else
    if TG_OP <> 'INSERT' then old_task_id := OLD.task_id; end if;
    if TG_OP <> 'DELETE' then new_task_id := NEW.task_id; end if;
  end if;

  for task_key in select distinct value from unnest(array[old_task_id, new_task_id]) as ids(value) where value is not null loop
    select * into task_row from ai_task where id = task_key;
    -- A whole retained graph may be deleted after owner/usage retention permits it.
    -- The existing restrictive keys reject deleting just its referenced task.
    if not found then continue; end if;
    select * into result_row from task_result where task_id = task_key;
    has_result := found;
    if (task_row.state = 'TERMINAL') <> has_result then
      raise exception 'Terminal task requires exactly one result; nonterminal task must have none' using errcode = '23514';
    end if;
    if has_result and result_row.attempt_id is not null and result_row.attempt_generation <> task_row.execution_generation then
      raise exception 'Terminal result cannot use a superseded execution generation' using errcode = '23514';
    end if;
    if task_row.state = 'RUNNING' then
      select * into attempt_row from task_attempt where id = task_row.active_attempt_id;
      if not found or attempt_row.attempt_number <> task_row.attempt_count or attempt_row.state in ('finished', 'fenced') then
        raise exception 'Running task requires its live current attempt slot' using errcode = '23514';
      end if;
    end if;
  end loop;
  return null;
end $$;
create constraint trigger ai_task_execution_consistency after insert or update or delete on ai_task
  deferrable initially deferred for each row execute function yuna_validate_task_execution();
create constraint trigger task_result_execution_consistency after insert or update or delete on task_result
  deferrable initially deferred for each row execute function yuna_validate_task_execution();
create constraint trigger task_attempt_execution_consistency after insert or update or delete on task_attempt
  deferrable initially deferred for each row execute function yuna_validate_task_execution();

-- Retention may erase output, but cannot rewrite a completed execution into a different
-- result. Accepted owner content is independent of this payload and its cleanup schedule.
create function yuna_task_result_immutability() returns trigger language plpgsql as $$
begin
  if (to_jsonb(NEW) - array['payload', 'payload_unavailable', 'pending_owner_discard', 'payload_purged_at', 'purge_reason', 'row_revision', 'updated_at'])
     is distinct from
     (to_jsonb(OLD) - array['payload', 'payload_unavailable', 'pending_owner_discard', 'payload_purged_at', 'purge_reason', 'row_revision', 'updated_at']) then
    raise exception 'Terminal result identity and outcome are immutable' using errcode = '23514';
  end if;
  if NEW.payload is distinct from OLD.payload and not
     (NEW.payload is null and NEW.payload_unavailable and NEW.payload_purged_at is not null and NEW.purge_reason is not null) then
    raise exception 'Terminal result payload may only be purged' using errcode = '23514';
  end if;
  if OLD.payload_unavailable and
     (not NEW.payload_unavailable or row(NEW.payload_purged_at, NEW.purge_reason) is distinct from row(OLD.payload_purged_at, OLD.purge_reason)) then
    raise exception 'Result purge history cannot be reversed' using errcode = '23514';
  end if;
  return NEW;
end $$;
create trigger task_result_immutable before update on task_result
  for each row execute function yuna_task_result_immutability();
`;
}
