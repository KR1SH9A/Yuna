-- Current same-channel context is distinct from immutable original moderation evidence.
-- Recheck every copied source before claim, disclosure and provider start using the existing owner lock order.
-- Upgrade only the previously shipped default; preserve custom channel limits and fence earlier replies.
update public.channel_reply_settings set limits=jsonb_set(limits,'{maxContextMessages}','8'::jsonb),
  row_revision=row_revision+1,updated_at=clock_timestamp()
  where limits='{"schemaVersion":1,"maxContextMessages":1,"maxContextCharacters":6000,"deadlineSeconds":120}'::jsonb;

create function public.yuna_chat_context_current(p_task uuid) returns boolean
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  t public.ai_task; p public.prepared_input; r public.conversation_request; e public.intake_event;
  context jsonb; message jsonb; binding jsonb; seen text[] := array[]::text[]; n timestamptz := clock_timestamp();
begin
  select * into t from public.ai_task where id=p_task;
  select * into p from public.prepared_input where id=t.prepared_input_id and task_id=t.id;
  select * into r from public.conversation_request where id=t.workflow_id and installation_id=t.installation_id and guild_id=t.guild_id;
  context:=p.payload->'chatContext';
  if context is null then return true; end if;
  if r.id is null or jsonb_typeof(context) is distinct from 'object'
    or context->>'guildId' is distinct from t.guild_id or context->>'channelId' is distinct from r.source_channel_id
    or context->>'sourceMessageId' is distinct from r.source_message_id
    or r.audience_binding->>'visibility' is distinct from 'channel'
    or r.audience_binding->>'channelId' is distinct from r.source_channel_id
    or jsonb_typeof(context->'messages') is distinct from 'array' or jsonb_array_length(context->'messages')>8
    or octet_length(p.payload::text)>28672 then return false; end if;
  for message in select value from jsonb_array_elements(context->'messages') loop
    if not coalesce(message->>'id' ~ '^[0-9]{1,20}$',false) or message->>'id'=any(seen)
      or message->>'id'=r.source_message_id then return false; end if;
    select * into e from public.intake_event where installation_id=t.installation_id and guild_id=t.guild_id
      and source_key='context:'||r.source_channel_id||':'||(message->>'id');
    if not found or not e.is_current_source_marker or e.source_validity<>'present' or e.payload_purged_at is not null or e.purge_after<=n
      or e.content_hash is distinct from message->>'contentHash' or e.author_user_id is distinct from message->>'authorId'
      or e.snapshot->'fields'->>'text' is distinct from message->>'content' then return false; end if;
    select value into binding from jsonb_array_elements(r.context_bindings) where value->>'owner'='intake' and value->>'recordId'=e.id::text;
    if not found or binding->>'revision' is distinct from e.source_version::text or binding->>'contentHash' is distinct from e.content_hash then return false; end if;
    seen:=array_append(seen,message->>'id');
  end loop;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
revoke all on function public.yuna_chat_context_current(uuid) from public,yuna_bot,yuna_worker;

create or replace function public.yuna_conversation_gate(p_task uuid) returns boolean
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  t public.ai_task; i public.guild_installation; s public.guild_safety_state;
  e public.intake_event; r public.conversation_request; p public.prepared_input;
  n timestamptz;
begin
  select * into t from public.ai_task where id=p_task;
  if not found or t.kind<>'community.generate' or t.schema_version<>1 or t.owner<>'community' then return false; end if;
  select * into i from public.guild_installation where id=t.installation_id and guild_id=t.guild_id for update;
  select * into s from public.guild_safety_state where installation_id=t.installation_id and guild_id=t.guild_id for update;
  select * into e from public.intake_event where id=(t.validity_bindings->>'sourceEventId')::uuid
    and installation_id=t.installation_id and guild_id=t.guild_id for update;
  select * into r from public.conversation_request where id=t.workflow_id and installation_id=t.installation_id and guild_id=t.guild_id for update;
  select * into t from public.ai_task where id=p_task for update;
  select * into p from public.prepared_input where id=t.prepared_input_id and task_id=t.id for update;
  n:=clock_timestamp();
  return coalesce(
    i.state='active' and i.feature_admission->>'community' in ('enabled','read_only')
    and s.id is not null and not s.paused and s.safety_revision=(t.validity_bindings->>'safetyRevision')::integer
    and e.is_current_source_marker and e.source_validity='present' and e.source_version=(t.validity_bindings->>'sourceRevision')::integer
    and e.payload_purged_at is null and n<e.purge_after
    and r.stage='generating' and r.expected_task_id=t.id and r.canceled_at is null and r.payload_purged_at is null and n<r.deadline
    and t.source_use='current_source' and t.deadline is not null and n<t.deadline
    and p.eligible and p.payload is not null and p.cleanup_state='retained' and p.source_event_id=e.id and p.content_hash=t.input_hash
    and p.validity_bindings=t.validity_bindings and p.schema_version=1 and p.expires_at is not null and n<p.expires_at and n<p.purge_after
    and public.yuna_knowledge_context_current(t.id) and public.yuna_chat_context_current(t.id), false);
end $$;
