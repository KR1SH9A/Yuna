-- Conversation pilot worker boundary. Apply with the core schema in a reviewed transaction.
-- The trusted migration owner owns these functions; yuna_worker must never inherit that role.
-- public is trusted only after setup revokes CREATE from PUBLIC and runtime roles.
-- Internal helpers deliberately receive no runtime EXECUTE grants.

-- Deferred constraint triggers run after the worker function's definer frame returns.
-- Keep the existing guard intact, but let only that guard read its related rows as its owner.
alter function public.yuna_validate_task_execution() security definer
  set search_path = pg_catalog, public, pg_temp;
revoke all on function public.yuna_validate_task_execution() from public,yuna_bot,yuna_worker;

-- Acquire the same installation -> safety -> source -> owner -> task/input locks as the bot.
-- Returns eligibility, while retaining the locks even when a known task became ineligible.
create function public.yuna_conversation_gate(p_task uuid) returns boolean
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
    i.state = 'active' and i.feature_admission->>'community' = 'enabled'
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
    and p.expires_at is not null and n < p.expires_at and n < p.purge_after, false);
end $$;

-- One terminal envelope and completion wake-up; caller holds task/attempt locks and accounts usage.
create function public.yuna_conversation_terminal(p_task uuid, p_outcome text, p_reason text, p_payload jsonb, p_now timestamptz)
returns void language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; a public.task_attempt; retention timestamptz;
begin
  select * into t from public.ai_task where id = p_task for update;
  if not found or t.state = 'TERMINAL' then return; end if;
  select * into a from public.task_attempt where id = t.active_attempt_id;
  select greatest(purge_after, p_now + interval '1 second') into retention from public.prepared_input where id = t.prepared_input_id;
  insert into public.task_result
    (id,created_at,installation_id,guild_id,task_id,attempt_id,attempt_generation,outcome,schema_version,
     payload,reason,usage_reservation_id,execution_started_at,completed_at,payload_unavailable,pending_owner_discard,purge_after,row_revision,updated_at)
  values (gen_random_uuid(),p_now,t.installation_id,t.guild_id,t.id,a.id,a.generation,p_outcome,1,
    p_payload,p_reason,a.reservation_id,a.started_at,p_now,false,false,retention,1,p_now);
  update public.ai_task set state='TERMINAL',active_attempt_id=null,next_attempt_at=null,park_reason=null,
    row_revision=row_revision+1,updated_at=p_now where id=t.id;
  update public.prepared_input set eligible=false,invalidated_at=coalesce(invalidated_at,p_now),
    invalidation_reason=coalesce(invalidation_reason,'task_terminal'),cleanup_state=case when cleanup_state='purged' then 'purged' else 'pending' end,
    row_revision=row_revision+1,updated_at=p_now where id=t.prepared_input_id;
  insert into public.outbox_entry
    (id,created_at,installation_id,guild_id,topic,schema_version,record_id,deduplication_key,state,claim_generation,attempt_count,next_attempt_at,row_revision,updated_at)
  values (gen_random_uuid(),p_now,t.installation_id,t.guild_id,'task.complete',1,t.id,'task.complete:'||t.id,'pending',0,0,p_now,1,p_now)
  on conflict (deduplication_key) do nothing;
end $$;

-- Unpriced units are retained as estimated liability. No timeout is reported as zero spend.
-- A claim that never disclosed input is the sole automatic confirmed-no-dispatch case.
create function public.yuna_conversation_account(p_attempt uuid, p_usage jsonb, p_provider_ref text, p_kind text, p_now timestamptz)
returns void language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  a public.task_attempt; u public.usage_reservation; prior public.usage_entry;
  units jsonb; new_evidence jsonb; no_dispatch boolean;
begin
  select * into a from public.task_attempt where id=p_attempt for update;
  if not found then return; end if;
  select * into u from public.usage_reservation where id=a.reservation_id for update;
  select * into prior from public.usage_entry where reservation_id=u.id for update;
  no_dispatch := a.input_released_at is null;
  units := case when p_usage is not null then jsonb_build_object(
    'input_tokens',(p_usage->>'inputTokens')::bigint,'output_tokens',(p_usage->>'outputTokens')::bigint,
    'requests',1) else u.reserved_units end;
  new_evidence := jsonb_build_object('kind',case when no_dispatch then 'confirmed_no_dispatch'
    when p_usage is not null then 'provider_response' else p_kind end,
    'reference',coalesce(p_provider_ref,a.id::text),'observedAt',p_now);
  if prior.id is null then
    insert into public.usage_entry
      (id,created_at,installation_id,guild_id,reservation_id,operation_kind,operation_key,attempt_id,provider,
       provider_request_id,pricing_version,currency,accounting_state,actual_cost,reported_units,evidence,
       first_recorded_at,last_evidence_at,reconcile_after,row_revision,updated_at,purge_after)
    values (gen_random_uuid(),p_now,u.installation_id,u.guild_id,u.id,u.operation_kind,u.operation_key,a.id,u.provider,
      p_provider_ref,u.pricing_version,u.currency,case when no_dispatch then 'no-spend' else 'estimated' end,
      case when no_dispatch then 0 else null end,units,jsonb_build_array(new_evidence),p_now,p_now,
      case when no_dispatch then null else p_now+interval '1 day' end,1,p_now,u.purge_after);
  elsif not no_dispatch and p_usage is not null and prior.accounting_state='estimated'
    and (prior.reported_units is distinct from units or prior.provider_request_id is distinct from p_provider_ref) then
    update public.usage_entry ue set reported_units=units,provider_request_id=coalesce(p_provider_ref,provider_request_id),
      evidence=case when jsonb_array_length(ue.evidence)<64 then ue.evidence||jsonb_build_array(new_evidence) else ue.evidence end,
      last_evidence_at=p_now,reconcile_after=p_now+interval '1 day',row_revision=row_revision+1,updated_at=p_now
      where id=prior.id;
  end if;
  if u.state in ('reserved','liability') then
    update public.usage_reservation set state=case when no_dispatch then 'released' else 'liability' end,
      released_at=case when no_dispatch then p_now else null end,
      resolution_reason=new_evidence->>'kind',resolution_evidence=new_evidence,
      reconcile_after=p_now+interval '1 day',row_revision=row_revision+1,updated_at=p_now where id=u.id;
  end if;
end $$;

-- Claiming consumes a daily opportunity even if the process later crashes. Counts span installs.
create function public.yuna_conversation_claim(p_executor text, p_model text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  candidate uuid; t public.ai_task; p public.prepared_input; policy public.usage_policy;
  n timestamptz; day_start timestamptz; cap integer; used bigint; budget_key text;
  attempt_id uuid; reservation_id uuid; lease timestamptz; gen integer;
begin
  if p_executor is null or length(p_executor) not between 1 and 256
    or p_model is null or length(p_model) not between 1 and 512 then raise exception 'Invalid worker routing' using errcode='22023'; end if;
  for candidate in select id from public.ai_task where state='READY' and kind='community.generate'
    and schema_version=1 and owner='community' and model_version=p_model and deadline>clock_timestamp()
    order by created_at,id limit 50 loop
    if not public.yuna_conversation_gate(candidate) then continue; end if;
    select * into t from public.ai_task where id=candidate;
    if t.state<>'READY' or t.attempt_count<>0 or t.max_attempts<>1 or t.model_version<>p_model
      or t.provider_configuration_version<>'deepseek-direct-v1' or t.prompt_version<>'conversation-v1' then continue; end if;
    n := clock_timestamp();
    if n>=t.deadline then continue; end if;
    select * into p from public.prepared_input where id=t.prepared_input_id;
    if jsonb_typeof(p.payload->'text') is distinct from 'string' or length(p.payload->>'text') not between 1 and 4000
      or (p.payload->'previousReply' is not null and (jsonb_typeof(p.payload->'previousReply') is distinct from 'string' or length(p.payload->>'previousReply')>2000))
      or not coalesce(p.payload->>'maxOutputTokens' ~ '^[1-9][0-9]{0,3}$',false)
      or (p.payload->>'maxOutputTokens')::integer>1024 then continue; end if;
    select * into policy from public.usage_policy where installation_id=t.installation_id and guild_id=t.guild_id for update;
    if policy.id is null or policy.effective_at>n then continue; end if;
    select value->>'budgetKey' into budget_key from jsonb_array_elements(policy.limits::jsonb)
      where value->>'feature'='community' and value->>'provider'='deepseek'
      and value->'allowance'->>'mode'='unlimited'
      and value->>'budgetKey' ~ '^conversation[.]daily-attempts:([1-9]|1[0-9]|20)$' limit 1;
    if budget_key is null or not exists(select 1 from jsonb_array_elements(policy.window_rules::jsonb)
      where value->>'budgetKey'=budget_key and value->>'durationSeconds'='86400') then continue; end if;
    cap := split_part(budget_key,':',2)::integer;
    day_start := date_trunc('day',n at time zone 'UTC') at time zone 'UTC';
    perform pg_advisory_xact_lock(hashtextextended('yuna:deepseek:day:'||t.guild_id||':'||to_char(day_start at time zone 'UTC','YYYY-MM-DD'),0));
    n:=clock_timestamp();
    if n>=t.deadline or n>=day_start+interval '1 day' then return null; end if;
    select count(*) into used from public.usage_reservation where guild_id=t.guild_id and provider='deepseek'
      and feature='community' and reserved_at>=day_start and reserved_at<day_start+interval '1 day';
    if used>=cap then continue; end if;
    attempt_id:=gen_random_uuid(); reservation_id:=gen_random_uuid(); gen:=t.execution_generation+1;
    lease:=least(t.deadline,n+interval '120 seconds');
    insert into public.usage_reservation
      (id,created_at,installation_id,guild_id,feature,provider,model_route,operation_kind,operation_key,task_id,attempt_number,
       attempt_id,reserved_units,reserved_cost,currency,usage_policy_id,policy_revision,policy_snapshot,pricing_version,
       budget_windows,state,reserved_at,reconcile_after,row_revision,updated_at,purge_after)
    values (reservation_id,n,t.installation_id,t.guild_id,'community','deepseek',p_model,'task-attempt',t.id::text||':1',t.id,1,
      attempt_id,jsonb_build_object('requests',1,'input_characters',4000,'previous_reply_characters',2000,'output_tokens',(p.payload->>'maxOutputTokens')::integer),
      0,'USD',policy.id,policy.policy_revision,jsonb_build_object('dailyAttemptLimit',cap,'monetaryEstimateAvailable',false),
      'unpriced-bounded-units-v1',jsonb_build_array(jsonb_build_object('key',budget_key,'startsAt',day_start,'endsAt',day_start+interval '1 day')),
      'reserved',n,n+interval '1 day',1,n,n+interval '30 days');
    insert into public.task_attempt
      (id,created_at,installation_id,guild_id,task_id,attempt_number,generation,executor_id,reservation_id,lease_until,claimed_at,state,row_revision,updated_at)
    values (attempt_id,n,t.installation_id,t.guild_id,t.id,1,gen,p_executor,reservation_id,lease,n,'claimed',1,n);
    update public.ai_task set state='RUNNING',active_attempt_id=attempt_id,attempt_count=1,execution_generation=gen,
      next_attempt_at=null,park_reason=null,row_revision=row_revision+1,updated_at=n where id=t.id;
    -- Polling directly consumes this wake-up; task/result scans remain authoritative.
    update public.outbox_entry set state='published',published_at=n,claimed_by=null,lease_until=null,
      claim_generation=claim_generation+1,attempt_count=attempt_count+1,row_revision=row_revision+1,updated_at=n
      where record_id=t.id and topic='task.execute' and state<>'published';
    return jsonb_build_object('taskId',t.id,'attemptId',attempt_id,'generation',gen,'executorId',p_executor,
      'deadline',t.deadline,'leaseUntil',lease,'kind',t.kind,'schemaVersion',1,'model',p_model,'promptVersion',t.prompt_version);
  end loop;
  return null;
end $$;

-- A claim is not permission to read input. Releasing is one-shot and serialized with revocation.
create function public.yuna_conversation_release(p_task uuid,p_attempt uuid,p_generation integer,p_executor text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; a public.task_attempt; n timestamptz; payload jsonb;
begin
  if p_task is null or p_attempt is null or p_generation is null or p_generation<1 or p_executor is null then return null; end if;
  if not public.yuna_conversation_gate(p_task) then return null; end if;
  select * into t from public.ai_task where id=p_task;
  select * into a from public.task_attempt where id=p_attempt and task_id=t.id for update;
  n:=clock_timestamp();
  if a.id is null or t.state<>'RUNNING' or t.active_attempt_id<>a.id or t.execution_generation<>p_generation
    or a.generation<>p_generation or a.executor_id<>p_executor or a.state<>'claimed' or n>=a.lease_until or n>=t.deadline then return null; end if;
  update public.task_attempt set state='released',input_released_at=n,row_revision=row_revision+1,updated_at=n where id=a.id;
  select p.payload into payload from public.prepared_input p where p.id=t.prepared_input_id;
  return payload;
end $$;

-- Commit intent immediately before I/O. A repeated start never grants another dispatch.
create function public.yuna_conversation_start(p_task uuid,p_attempt uuid,p_generation integer,p_executor text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; a public.task_attempt; n timestamptz;
begin
  if p_task is null or p_attempt is null or p_generation is null or p_generation<1 or p_executor is null then return false; end if;
  if not public.yuna_conversation_gate(p_task) then return false; end if;
  select * into t from public.ai_task where id=p_task;
  select * into a from public.task_attempt where id=p_attempt and task_id=t.id for update;
  n:=clock_timestamp();
  if a.id is null or t.state<>'RUNNING' or t.active_attempt_id<>a.id or t.execution_generation<>p_generation
    or a.generation<>p_generation or a.executor_id<>p_executor or a.state<>'released' or n>=a.lease_until or n>=t.deadline then return false; end if;
  update public.task_attempt set state='executing',started_at=n,row_revision=row_revision+1,updated_at=n where id=a.id;
  return true;
end $$;

-- Validate result/usage envelopes, retain late billing facts, and fence publication by live authority.
create function public.yuna_conversation_finish(p_task uuid,p_attempt uuid,p_generation integer,p_executor text,p_result jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  t public.ai_task; a public.task_attempt; n timestamptz; eligible boolean; live boolean;
  result_outcome text; reason text; payload jsonb; usage jsonb; provider_ref text; value text;
begin
  if p_task is null or p_attempt is null or p_generation is null or p_generation<1 or p_executor is null then return false; end if;
  if p_result is null or jsonb_typeof(p_result)<>'object' or pg_column_size(p_result)>32768 then raise exception 'Invalid task outcome' using errcode='22023'; end if;
  result_outcome:=p_result->>'outcome'; reason:=p_result->>'reason'; payload:=p_result->'payload'; usage:=p_result->'usage';
  provider_ref:=coalesce(p_result->>'providerRequestId',payload->>'providerRequestId');
  if result_outcome is null or result_outcome not in ('success','failure','uncertain') or reason is null or length(reason) not between 1 and 256
    or (provider_ref is not null and length(provider_ref) not between 1 and 512) then raise exception 'Invalid task outcome' using errcode='22023'; end if;
  if usage is not null then
    if jsonb_typeof(usage)<>'object' then raise exception 'Invalid usage' using errcode='22023'; end if;
    foreach value in array array[usage->>'inputTokens',usage->>'outputTokens'] loop
      if value is null or value !~ '^(0|[1-9][0-9]{0,9})$' or value::numeric>2147483647 then raise exception 'Invalid usage' using errcode='22023'; end if;
    end loop;
  end if;
  if result_outcome='success' then
    if payload is null or jsonb_typeof(payload)<>'object' or jsonb_typeof(payload->'text') is distinct from 'string'
      or length(payload->>'text') not between 1 and 2000 or jsonb_typeof(payload->'truncated') is distinct from 'boolean'
      or jsonb_typeof(payload->'model') is distinct from 'string' or length(payload->>'model') not between 1 and 512 or provider_ref is null then raise exception 'Invalid reply result' using errcode='22023'; end if;
    foreach value in array array[payload->>'inputTokens',payload->>'outputTokens',payload->>'totalTokens'] loop
      if value is null or value !~ '^(0|[1-9][0-9]{0,9})$' or value::numeric>2147483647 then raise exception 'Invalid reply usage' using errcode='22023'; end if;
    end loop;
    if (payload->>'totalTokens')::bigint<>(payload->>'inputTokens')::bigint+(payload->>'outputTokens')::bigint then raise exception 'Inconsistent reply usage' using errcode='22023'; end if;
    usage:=jsonb_build_object('inputTokens',(payload->>'inputTokens')::bigint,'outputTokens',(payload->>'outputTokens')::bigint);
    payload:=jsonb_build_object('text',payload->>'text','providerRequestId',provider_ref,'model',payload->>'model',
      'inputTokens',(payload->>'inputTokens')::bigint,'outputTokens',(payload->>'outputTokens')::bigint,
      'totalTokens',(payload->>'totalTokens')::bigint,'truncated',(payload->>'truncated')::boolean);
  else payload:=null; end if;
  eligible:=public.yuna_conversation_gate(p_task);
  select * into t from public.ai_task where id=p_task;
  select * into a from public.task_attempt where id=p_attempt and task_id=p_task for update;
  if t.id is null or t.owner<>'community' or t.kind<>'community.generate' or t.schema_version<>1 or a.id is null
    or a.executor_id<>p_executor or a.generation<>p_generation then return false; end if;
  if result_outcome='success' and a.started_at is null then raise exception 'Reply does not match execution' using errcode='22023'; end if;
  if usage is not null and a.input_released_at is null then raise exception 'Usage requires released input' using errcode='22023'; end if;
  n:=clock_timestamp();
  perform public.yuna_conversation_account(a.id,usage,provider_ref,'timeout',n);
  live:=t.state='RUNNING' and t.active_attempt_id=a.id and t.execution_generation=p_generation
    and a.state not in ('finished','fenced') and n<a.lease_until and n<t.deadline;
  if t.state='TERMINAL' then return false; end if;
  if not live or not eligible then
    update public.task_attempt set state='fenced',finished_at=coalesce(finished_at,n),row_revision=row_revision+1,updated_at=n where id=a.id and state not in ('finished','fenced');
    perform public.yuna_conversation_terminal(t.id,case when n>=t.deadline then 'expired' else 'canceled' end,'execution_no_longer_eligible',null,n);
    return false;
  end if;
  update public.task_attempt set state='finished',finished_at=n,provider_request_id=provider_ref,
    failure_class=case result_outcome when 'success' then null when 'uncertain' then 'uncertain' else 'permanent' end,
    failure_code=case when result_outcome='success' then null else reason end,row_revision=row_revision+1,updated_at=n where id=a.id;
  perform public.yuna_conversation_terminal(t.id,result_outcome,reason,payload,n);
  return true;
end $$;

-- Bot maintenance owns recovery. No retries: disclosed lost work has an uncertain outcome.
create function public.yuna_conversation_recover(p_limit integer) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare candidate uuid; t public.ai_task; a public.task_attempt; eligible boolean; n timestamptz; recovered integer:=0; terminal_outcome text;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid recovery batch' using errcode='22023'; end if;
  for candidate in select id from public.ai_task where state<>'TERMINAL' and kind='community.generate' and owner='community' and schema_version=1
    order by deadline,created_at,id limit p_limit loop
    eligible:=public.yuna_conversation_gate(candidate);
    select * into t from public.ai_task where id=candidate;
    if t.state='TERMINAL' then continue; end if;
    select * into a from public.task_attempt where id=t.active_attempt_id for update;
    n:=clock_timestamp();
    if eligible and (a.id is null or n<a.lease_until) then continue; end if;
    terminal_outcome:=case when n<t.deadline and (a.id is null or n<a.lease_until) then 'canceled'
      when a.input_released_at is not null then 'uncertain' else 'expired' end;
    if a.id is not null then
      perform public.yuna_conversation_account(a.id,null,null,'lease_expired',n);
      update public.task_attempt set state='fenced',finished_at=coalesce(finished_at,n),failure_class=case when a.input_released_at is not null then 'uncertain' else 'permanent' end,
        failure_code='execution_expired',row_revision=row_revision+1,updated_at=n where id=a.id and state not in ('finished','fenced');
    end if;
    perform public.yuna_conversation_terminal(t.id,terminal_outcome,'execution_expired_or_invalidated',null,n);
    recovered:=recovered+1;
  end loop;
  return recovered;
end $$;

revoke all on function public.yuna_conversation_gate(uuid) from public;
revoke all on function public.yuna_conversation_terminal(uuid,text,text,jsonb,timestamptz) from public;
revoke all on function public.yuna_conversation_account(uuid,jsonb,text,text,timestamptz) from public;
revoke all on function public.yuna_conversation_claim(text,text) from public;
revoke all on function public.yuna_conversation_release(uuid,uuid,integer,text) from public;
revoke all on function public.yuna_conversation_start(uuid,uuid,integer,text) from public;
revoke all on function public.yuna_conversation_finish(uuid,uuid,integer,text,jsonb) from public;
revoke all on function public.yuna_conversation_recover(integer) from public;
grant execute on function public.yuna_conversation_claim(text,text) to yuna_worker;
grant execute on function public.yuna_conversation_release(uuid,uuid,integer,text) to yuna_worker;
grant execute on function public.yuna_conversation_start(uuid,uuid,integer,text) to yuna_worker;
grant execute on function public.yuna_conversation_finish(uuid,uuid,integer,text,jsonb) to yuna_worker;
grant execute on function public.yuna_conversation_recover(integer) to yuna_bot;
