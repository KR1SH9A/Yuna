-- Keep approved knowledge current at worker claim, input disclosure and provider start, even before retention runs.
-- Runtime roles cannot call this helper directly; existing restricted worker entry points reach it through the owner gate.
create function public.yuna_knowledge_context_current(p_task uuid) returns boolean
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  t public.ai_task; p public.prepared_input; r public.conversation_request; k public.knowledge_entry;
  bindings jsonb; contents jsonb; binding jsonb; content jsonb; position integer := 0;
  seen uuid[] := array[]::uuid[]; n timestamptz := clock_timestamp(); total_characters integer;
begin
  select * into t from public.ai_task where id=p_task;
  if not found then return false; end if;
  select * into p from public.prepared_input where id=t.prepared_input_id and task_id=t.id;
  select * into r from public.conversation_request where id=t.workflow_id and installation_id=t.installation_id and guild_id=t.guild_id;
  bindings := coalesce(t.validity_bindings->'knowledgeBindings','[]'::jsonb);
  contents := coalesce(p.payload->'approvedKnowledge','[]'::jsonb);
  if jsonb_typeof(bindings) is distinct from 'array' or jsonb_typeof(contents) is distinct from 'array'
    or jsonb_array_length(bindings)>5 or jsonb_array_length(bindings)<>jsonb_array_length(contents) then return false; end if;
  if jsonb_array_length(bindings)=0 then return true; end if;
  if r.id is null or r.audience_binding->>'visibility'<>'channel' or r.audience_binding->>'channelId'<>r.source_channel_id
    or octet_length(p.payload::text)>28672 then return false; end if;
  total_characters:=length(p.payload->>'text')+coalesce(length(p.payload->>'previousReply'),0);
  for binding in select value from jsonb_array_elements(bindings) loop
    content:=contents->position; position:=position+1;
    if jsonb_typeof(binding) is distinct from 'object' or jsonb_typeof(content) is distinct from 'object'
      or not coalesce(binding->>'entryId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false)
      or not coalesce(binding->>'revision' ~ '^[1-9][0-9]{0,9}$',false)
      or binding->>'channelId' is distinct from r.source_channel_id then return false; end if;
    select * into k from public.knowledge_entry where id=(binding->>'entryId')::uuid
      and installation_id=t.installation_id and guild_id=t.guild_id;
    if not found or k.id=any(seen) or k.retired_at is not null or k.payload_purged_at is not null
      or k.content is null or k.provenance is null or k.approved_at>n or k.purge_after<=n
      or k.row_revision<>(binding->>'revision')::integer or k.content_hash is distinct from binding->>'contentHash'
      or content->>'entryId' is distinct from k.id::text or content->>'revision' is distinct from k.row_revision::text
      or content->>'contentHash' is distinct from k.content_hash or content->>'content' is distinct from k.content
      or not coalesce(k.visibility->>'kind'='guild' or (k.visibility->>'kind'='channels'
        and k.visibility->'channelIds' @> jsonb_build_array(r.source_channel_id)),false) then return false; end if;
    seen:=array_append(seen,k.id); total_characters:=total_characters+length(k.content);
  end loop;
  return coalesce(total_characters<=6000,false);
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
revoke all on function public.yuna_knowledge_context_current(uuid) from public,yuna_bot,yuna_worker;

-- Preserve the shared installation/safety/source/task lock order while adding the approved-context check.
create or replace function public.yuna_conversation_gate(p_task uuid) returns boolean
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  t public.ai_task; i public.guild_installation; s public.guild_safety_state;
  e public.intake_event; r public.conversation_request; p public.prepared_input;
  n timestamptz;
begin
  select * into t from public.ai_task where id = p_task;
  if not found or t.kind <> 'community.generate' or t.schema_version <> 1 or t.owner <> 'community' then return false; end if;
  select * into i from public.guild_installation where id = t.installation_id and guild_id = t.guild_id for update;
  select * into s from public.guild_safety_state where installation_id = t.installation_id and guild_id = t.guild_id for update;
  select * into e from public.intake_event where id = (t.validity_bindings->>'sourceEventId')::uuid
    and installation_id = t.installation_id and guild_id = t.guild_id for update;
  select * into r from public.conversation_request where id = t.workflow_id
    and installation_id = t.installation_id and guild_id = t.guild_id for update;
  select * into t from public.ai_task where id = p_task for update;
  select * into p from public.prepared_input where id = t.prepared_input_id and task_id = t.id for update;
  n := clock_timestamp();
  return coalesce(
    i.state = 'active' and i.feature_admission->>'community' in ('enabled','read_only')
    and s.id is not null and not s.paused and s.safety_revision = (t.validity_bindings->>'safetyRevision')::integer
    and e.is_current_source_marker and e.source_validity = 'present'
    and e.source_version = (t.validity_bindings->>'sourceRevision')::integer
    and e.payload_purged_at is null and n < e.purge_after
    and r.stage = 'generating' and r.expected_task_id = t.id and r.canceled_at is null
    and r.payload_purged_at is null and n < r.deadline
    and t.source_use = 'current_source' and t.deadline is not null and n < t.deadline
    and p.eligible and p.payload is not null and p.cleanup_state = 'retained'
    and p.source_event_id = e.id and p.content_hash = t.input_hash
    and p.validity_bindings = t.validity_bindings and p.schema_version = 1
    and p.expires_at is not null and n < p.expires_at and n < p.purge_after
    and public.yuna_knowledge_context_current(t.id), false);
end $$;
