/**
 * Cross-row moderation rules supplement the entity methods and scoped foreign keys.
 * Deferred checks see all rows inserted by one local acceptance/dispatch transaction.
 * They establish persisted provenance, not current Discord permissions or external outcomes.
 */
export function moderationConstraintSql(): string {
  return `
create function yuna_validate_action_findings() returns trigger language plpgsql as $$
declare
  action_key uuid;
  action_row moderation_action;
  evidence_row evidence_revision;
  policy_row moderation_policy_revision;
  finding_count integer;
  requires_available boolean := false;
  eligibility_at timestamptz;
begin
  if TG_TABLE_NAME = 'moderation_action' then
    action_key := coalesce(NEW.id, OLD.id);
  else
    action_key := coalesce(NEW.action_id, OLD.action_id);
  end if;
  select * into action_row from moderation_action where id = action_key;
  if not found then return null; end if;

  select count(*) into finding_count from moderation_action_finding where action_id = action_key;
  if action_row.origin = 'policy' and finding_count = 0 then
    raise exception 'Policy action requires contributing findings' using errcode = '23514';
  end if;
  if action_row.origin = 'staff' and finding_count <> 0 then
    raise exception 'Staff action cannot acquire policy authority through a finding link' using errcode = '23514';
  end if;
  if exists (
    select 1 from moderation_action_finding link join moderation_finding f on f.id = link.finding_id
    where link.action_id = action_key and
      (f.installation_id <> action_row.installation_id or f.guild_id <> action_row.guild_id or
       f.case_id is distinct from action_row.case_id or
       f.evidence_revision_id is distinct from action_row.evidence_revision_id or
       f.policy_revision_id is distinct from action_row.policy_revision_id)
  ) then
    raise exception 'Action findings must match exact scope, case, evidence and policy' using errcode = '23514';
  end if;
  if action_row.origin <> 'policy' then return null; end if;

  select * into evidence_row from evidence_revision where id = action_row.evidence_revision_id;
  if not found or evidence_row.original_author_user_id is distinct from action_row.target_user_id
     or evidence_row.author_kind not in ('user', 'bot') then
    raise exception 'Policy action must target the attributable original author' using errcode = '23514';
  end if;
  select * into policy_row from moderation_policy_revision where id = action_row.policy_revision_id;
  if not found then
    raise exception 'Policy action requires its immutable policy revision' using errcode = '23514';
  end if;
  if exists (
    select 1 from moderation_action_finding link join moderation_finding f on f.id = link.finding_id
    where link.action_id = action_key and (
      not (f.disposition = 'violation' or (action_row.kind = 'warning' and f.disposition = 'suspicion')) or
      not exists (
        select 1 from jsonb_array_elements(policy_row.action_mapping) mapping
        where mapping->>'ruleId' = f.rule_id
          and mapping->>'supportedDisposition' = f.disposition
          and mapping->>'action' = action_row.kind
          and (action_row.kind <> 'ban' or action_row.operation_payload is null or
            mapping->>'deleteMessageSeconds' = action_row.operation_payload->>'deleteMessageSeconds')
      )
    )
  ) then
    raise exception 'Every contributing finding must support the exact policy operation' using errcode = '23514';
  end if;

  -- A later mandatory purge must remain possible, including while an effect is unresolved.
  -- Recheck availability when preparing intent or claiming a new dispatch, not on outcome writes.
  if TG_TABLE_NAME = 'moderation_action' then
    if TG_OP = 'INSERT' then
      requires_available := action_row.state in ('READY', 'DISPATCHED');
      eligibility_at := NEW.created_at;
    elsif NEW.state = 'DISPATCHED' and NEW.execution_generation > OLD.execution_generation then
      requires_available := true;
      eligibility_at := NEW.updated_at;
    end if;
  end if;
  if requires_available then
    if evidence_row.payload_purged_at is not null or evidence_row.purge_after <= eligibility_at
       or action_row.payload_purged_at is not null or action_row.purge_after <= eligibility_at then
      raise exception 'New policy intent and dispatch require available original evidence and payload' using errcode = '23514';
    end if;
    if evidence_row.purge_after < action_row.purge_after then
      raise exception 'Action review cannot extend original evidence retention' using errcode = '23514';
    end if;
    if exists (
      select 1 from moderation_action_finding link join moderation_finding f on f.id = link.finding_id
      where link.action_id = action_key and
        (f.payload_purged_at is not null or f.purge_after <= eligibility_at or f.purge_after < action_row.purge_after)
    ) then
      raise exception 'Action review requires retained accepted explanations within their deadlines' using errcode = '23514';
    end if;
  end if;
  return null;
end $$;
create constraint trigger moderation_action_findings_required after insert or update on moderation_action
  deferrable initially deferred for each row execute function yuna_validate_action_findings();
create constraint trigger moderation_action_findings_scope after insert or update or delete on moderation_action_finding
  deferrable initially deferred for each row execute function yuna_validate_action_findings();

create function yuna_original_evidence_guard() returns trigger language plpgsql as $$
declare
  original_event intake_event;
  source_case moderation_case;
  previous_capture evidence_revision;
begin
  select * into original_event from intake_event where id = NEW.original_event_id;
  if not found or original_event.event_kind <> 'message_create' then
    raise exception 'Original evidence requires a captured message-create event' using errcode = '23514';
  end if;
  if original_event.installation_id <> NEW.installation_id or original_event.guild_id <> NEW.guild_id
     or original_event.author_kind <> NEW.author_kind
     or (NEW.original_author_user_id is not null and original_event.author_user_id is distinct from NEW.original_author_user_id) then
    raise exception 'Original evidence must preserve captured author and tenant provenance' using errcode = '23514';
  end if;
  if TG_OP = 'INSERT' and NEW.original_content is not null and original_event.content_access <> 'available' then
    raise exception 'Unavailable original content cannot be replaced with a later body' using errcode = '23514';
  end if;
  select * into source_case from moderation_case where id = NEW.case_id;
  if not found or source_case.installation_id <> NEW.installation_id or source_case.guild_id <> NEW.guild_id
     or source_case.source_channel_id <> NEW.source_channel_id or source_case.source_message_id <> NEW.source_message_id then
    raise exception 'Original evidence must retain its case source identity' using errcode = '23514';
  end if;

  if TG_OP = 'INSERT' then
    if NEW.supersedes_evidence_id is not null then
      select * into previous_capture from evidence_revision where id = NEW.supersedes_evidence_id;
      if not found or previous_capture.installation_id <> NEW.installation_id or previous_capture.guild_id <> NEW.guild_id
         or previous_capture.case_id <> NEW.case_id or previous_capture.original_event_id <> NEW.original_event_id
         or previous_capture.source_channel_id <> NEW.source_channel_id or previous_capture.source_message_id <> NEW.source_message_id then
        raise exception 'Capture completion requires the exact original predecessor' using errcode = '23514';
      end if;
      if NEW.capture_revision <> previous_capture.capture_revision + 1 or NEW.captured_at < previous_capture.captured_at
         or previous_capture.payload_purged_at is not null or previous_capture.purge_after <= NEW.captured_at
         or NEW.purge_after > previous_capture.purge_after then
        raise exception 'Capture completion cannot revive expired evidence or extend its retention' using errcode = '23514';
      end if;
      if (previous_capture.original_content is not null and previous_capture.original_content is distinct from NEW.original_content)
         or previous_capture.original_attachment_descriptors is distinct from NEW.original_attachment_descriptors then
        raise exception 'Capture completion cannot replace original body or attachments' using errcode = '23514';
      end if;
    end if;
  else
    if (to_jsonb(NEW) - array['original_content', 'original_attachment_descriptors', 'artifact_references', 'payload_purged_at', 'purge_reason'])
       is distinct from
       (to_jsonb(OLD) - array['original_content', 'original_attachment_descriptors', 'artifact_references', 'payload_purged_at', 'purge_reason']) then
      raise exception 'Original evidence identity and interpretation are immutable' using errcode = '23514';
    end if;
    if row(NEW.original_content, NEW.original_attachment_descriptors, NEW.artifact_references, NEW.payload_purged_at, NEW.purge_reason)
       is distinct from row(OLD.original_content, OLD.original_attachment_descriptors, OLD.artifact_references, OLD.payload_purged_at, OLD.purge_reason)
       and not (OLD.payload_purged_at is null and NEW.original_content is null and NEW.original_attachment_descriptors is null
         and NEW.artifact_references is null and NEW.payload_purged_at is not null and NEW.purge_reason is not null) then
      raise exception 'Original evidence can only be purged once, never edited' using errcode = '23514';
    end if;
  end if;
  return NEW;
end $$;
create constraint trigger evidence_original_guard after insert or update on evidence_revision
  deferrable initially deferred for each row execute function yuna_original_evidence_guard();

create function yuna_moderation_case_identity_guard() returns trigger language plpgsql as $$
begin
  if row(NEW.id, NEW.installation_id, NEW.guild_id, NEW.created_at, NEW.source_channel_id, NEW.source_message_id)
     is distinct from row(OLD.id, OLD.installation_id, OLD.guild_id, OLD.created_at, OLD.source_channel_id, OLD.source_message_id)
     or (OLD.original_event_id is not null and NEW.original_event_id is distinct from OLD.original_event_id) then
    raise exception 'Moderation case original source identity is immutable' using errcode = '23514';
  end if;
  return NEW;
end $$;
create constraint trigger moderation_case_identity_guard after update on moderation_case
  deferrable initially deferred for each row execute function yuna_moderation_case_identity_guard();

create function yuna_moderation_finding_guard() returns trigger language plpgsql as $$
declare policy_row moderation_policy_revision;
begin
  select * into policy_row from moderation_policy_revision where id = NEW.policy_revision_id;
  if not found or not exists (
    select 1 from jsonb_array_elements(policy_row.rules) rule
    where rule->>'id' = NEW.rule_id and rule->>'version' = NEW.rule_version
  ) then
    raise exception 'Finding must identify a rule in its exact policy revision' using errcode = '23514';
  end if;
  if TG_OP = 'UPDATE' then
    if (to_jsonb(NEW) - array['supported_facts', 'evidence_references', 'exclusions', 'coverage', 'payload_purged_at', 'purge_reason'])
       is distinct from
       (to_jsonb(OLD) - array['supported_facts', 'evidence_references', 'exclusions', 'coverage', 'payload_purged_at', 'purge_reason']) then
      raise exception 'Accepted finding identity and disposition are immutable' using errcode = '23514';
    end if;
    if row(NEW.supported_facts, NEW.evidence_references, NEW.exclusions, NEW.coverage, NEW.payload_purged_at, NEW.purge_reason)
       is distinct from row(OLD.supported_facts, OLD.evidence_references, OLD.exclusions, OLD.coverage, OLD.payload_purged_at, OLD.purge_reason)
       and not (OLD.payload_purged_at is null and NEW.supported_facts is null and NEW.evidence_references is null
         and NEW.exclusions is null and NEW.coverage is null and NEW.payload_purged_at is not null and NEW.purge_reason is not null) then
      raise exception 'Accepted finding payload can only be purged once, never edited' using errcode = '23514';
    end if;
  end if;
  return NEW;
end $$;
create constraint trigger moderation_finding_guard after insert or update on moderation_finding
  deferrable initially deferred for each row execute function yuna_moderation_finding_guard();

create function yuna_moderation_action_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(NEW) - array['state', 'execution_generation', 'active_attempt_id', 'next_attempt_at', 'outcome_summary',
       'row_revision', 'updated_at', 'operation_payload', 'payload_purged_at', 'purge_reason'])
     is distinct from
     (to_jsonb(OLD) - array['state', 'execution_generation', 'active_attempt_id', 'next_attempt_at', 'outcome_summary',
       'row_revision', 'updated_at', 'operation_payload', 'payload_purged_at', 'purge_reason']) then
    raise exception 'Moderation action intent, authority and evidence identity are immutable' using errcode = '23514';
  end if;
  if row(NEW.operation_payload, NEW.payload_purged_at, NEW.purge_reason)
     is distinct from row(OLD.operation_payload, OLD.payload_purged_at, OLD.purge_reason)
     and not (OLD.payload_purged_at is null and NEW.operation_payload is null and NEW.payload_purged_at is not null and NEW.purge_reason is not null) then
    raise exception 'Moderation action payload can only be purged once, never rewritten' using errcode = '23514';
  end if;
  if NEW.updated_at < OLD.updated_at or NEW.row_revision < OLD.row_revision then
    raise exception 'Action revision and observation time cannot move backwards' using errcode = '23514';
  end if;
  if NEW.state is distinct from OLD.state and (
    (OLD.state = 'READY' and NEW.state in ('DISPATCHED', 'CANCELED')) or
    (OLD.state = 'DISPATCHED' and NEW.state in ('UNKNOWN', 'CONFIRMED', 'FAILED')) or
    (OLD.state = 'UNKNOWN' and NEW.state in ('CONFIRMED', 'FAILED')) or
    (OLD.state = 'FAILED' and NEW.state = 'READY' and OLD.outcome_summary->>'classification' = 'definitive_failure')
  ) IS NOT TRUE then
    raise exception 'Action state transition would discard unresolved or terminal authority' using errcode = '23514';
  end if;
  if NEW.state = 'DISPATCHED' and OLD.state = 'READY' then
    if NEW.execution_generation <> OLD.execution_generation + 1 or NEW.active_attempt_id is null then
      raise exception 'Dispatch requires one new generation and its exact attempt' using errcode = '23514';
    end if;
  elsif NEW.execution_generation <> OLD.execution_generation then
    raise exception 'Execution generation can advance only when dispatch is claimed' using errcode = '23514';
  end if;
  if OLD.state in ('DISPATCHED', 'UNKNOWN') and NEW.active_attempt_id is distinct from OLD.active_attempt_id then
    raise exception 'An unresolved action cannot hand off its active attempt' using errcode = '23514';
  end if;
  return NEW;
end $$;
create constraint trigger moderation_action_intent_guard after update on moderation_action
  deferrable initially deferred for each row execute function yuna_moderation_action_guard();

create function yuna_moderation_policy_immutable() returns trigger language plpgsql as $$
begin
  if to_jsonb(NEW) is distinct from to_jsonb(OLD) then
    raise exception 'Published moderation policy is immutable; publish another revision' using errcode = '23514';
  end if;
  return NEW;
end $$;
create constraint trigger moderation_policy_immutable after update on moderation_policy_revision
  deferrable initially deferred for each row execute function yuna_moderation_policy_immutable();
`;
}
