-- Original-evidence moderation worker boundary. No direct worker business table privileges.
-- Internal helpers execute only through scoped SECURITY DEFINER entry points.

create function public.yuna_moderation_gate(p_task uuid) returns boolean
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; i public.guild_installation; s public.guild_safety_state;
  c public.moderation_case; e public.evidence_revision; r public.moderation_policy_revision; p public.prepared_input;
  latest uuid; n timestamptz;
begin
  select * into t from public.ai_task where id=p_task;
  if not found or t.owner<>'moderation' or t.kind not in ('moderation.observe','moderation.assess') or t.schema_version<>1 then return false; end if;
  select * into i from public.guild_installation where id=t.installation_id and guild_id=t.guild_id for update;
  select * into s from public.guild_safety_state where installation_id=t.installation_id and guild_id=t.guild_id for update;
  select * into c from public.moderation_case where id=t.workflow_id and installation_id=t.installation_id and guild_id=t.guild_id for update;
  select * into e from public.evidence_revision where id=(t.validity_bindings->>'evidenceRevisionId')::uuid
    and installation_id=t.installation_id and guild_id=t.guild_id for update;
  select * into r from public.moderation_policy_revision where id=(t.validity_bindings->>'policyRevisionId')::uuid
    and installation_id=t.installation_id and guild_id=t.guild_id;
  select id into latest from public.moderation_policy_revision where installation_id=t.installation_id and guild_id=t.guild_id order by revision_number desc limit 1;
  select * into t from public.ai_task where id=p_task for update;
  select * into p from public.prepared_input where id=t.prepared_input_id and task_id=t.id for update;
  n:=clock_timestamp();
  return coalesce(i.state='active' and i.discord_availability='available' and i.feature_admission->>'moderation' in ('enabled','read_only')
    and i.operator_policy->'moderation'->>'enabled'='true' and s.id is not null and not s.paused
    and s.safety_revision=(t.validity_bindings->>'safetyRevision')::integer
    and c.expected_task_id=t.id and c.generation=(t.validity_bindings->>'ownerRevision')::integer
    and c.workflow_phase=t.stage and c.current_evidence_revision_id=e.id and c.policy_revision_id=r.id and latest=r.id
    and e.case_id=c.id and e.original_event_id=c.original_event_id and e.original_event_id=(t.validity_bindings->>'sourceEventId')::uuid
    and e.author_kind='user' and e.original_author_user_id is not null and e.original_author_user_id=c.subject_user_id
    and e.payload_purged_at is null and e.original_content is not null and n<e.purge_after
    and e.capture_coverage->>'contentAccess'='available' and e.capture_coverage->>'body'='captured'
    and t.source_use='original_evidence' and t.deadline is not null and n<t.deadline
    and p.eligible and p.payload is not null and p.cleanup_state='retained'
    and p.source_event_id=e.original_event_id and p.policy_revision_id=r.id and p.content_hash=t.input_hash
    and p.validity_bindings=t.validity_bindings and p.schema_version=1 and p.payload->>'kind'=t.kind
    and p.expires_at is not null and n<p.expires_at and n<p.purge_after
    and exists(select 1 from jsonb_array_elements(r.rules) rule where rule->>'id'=t.expected_variant and rule->>'enabled'='true'),false);
end $$;

create function public.yuna_moderation_claim(p_executor text, p_kind text, p_model text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  candidate uuid; t public.ai_task; p public.prepared_input; policy public.usage_policy;
  n timestamptz; day_start timestamptz; cap integer; used bigint; budget_key text;
  attempt_id uuid; reservation_id uuid; lease timestamptz; gen integer;
  provider_name text; money jsonb; price jsonb; reserved numeric; committed numeric; pricing text; currency_code text;
begin
  if p_executor is null or length(p_executor) not between 1 and 256
    or p_model is null or length(p_model) not between 1 and 512 then raise exception 'Invalid worker routing' using errcode='22023'; end if;
  if p_kind is null or p_kind not in ('moderation.observe','moderation.assess') then raise exception 'Unsupported moderation capability' using errcode='22023'; end if;
  provider_name:=case p_kind when 'moderation.observe' then 'deepseek' else 'openrouter' end;
  for candidate in select id from public.ai_task where state='READY' and kind=p_kind
    and schema_version=1 and owner='moderation' and model_version=p_model and deadline>clock_timestamp()
    order by created_at,id limit 50 loop
    if not public.yuna_moderation_gate(candidate) then continue; end if;
    select * into t from public.ai_task where id=candidate;
    if t.state<>'READY' or t.attempt_count<>0 or t.max_attempts<>1 or t.model_version<>p_model
      or t.provider_configuration_version<>(case p_kind when 'moderation.observe' then 'deepseek-observation-v1' else 'openrouter-decisions-v1' end) then continue; end if;
    n := clock_timestamp();
    if n>=t.deadline then continue; end if;
    select * into p from public.prepared_input where id=t.prepared_input_id;
    if p.payload->>'schemaVersion'<>'1' or p.payload->>'kind'<>p_kind or octet_length(p.payload::text)>32768
      or jsonb_typeof(p.payload->'input') is distinct from 'object' then continue; end if;
    if p_kind='moderation.observe' and (jsonb_typeof(p.payload->'input'->'content') is distinct from 'string'
      or length(p.payload->'input'->>'content')>16000 or p.payload->'input'->>'maxOutputTokens'<>'1024') then continue; end if;
    if p_kind='moderation.assess' and (jsonb_typeof(p.payload->'input'->'questions') is distinct from 'object'
      or p.payload->'input'->>'configurationVersion'<>t.validity_bindings->>'policyRevisionId') then continue; end if;
    select * into policy from public.usage_policy where installation_id=t.installation_id and guild_id=t.guild_id for update;
    if policy.id is null or policy.effective_at>n then continue; end if;
    select value->>'budgetKey' into budget_key from jsonb_array_elements(policy.limits::jsonb)
      where value->>'feature'='community' and value->>'provider'='deepseek'
      and value->'allowance'->>'mode'='unlimited'
      and value->>'budgetKey' ~ '^conversation[.]daily-attempts:([1-9][0-9]{0,5}|1000000)$' limit 1;
    if budget_key is null or not exists(select 1 from jsonb_array_elements(policy.window_rules::jsonb)
      where value->>'budgetKey'=budget_key and value->>'durationSeconds'='86400') then continue; end if;
    cap := split_part(budget_key,':',2)::integer;
    day_start := date_trunc('day',n at time zone 'UTC') at time zone 'UTC';
    perform pg_advisory_xact_lock(hashtextextended('yuna:attempts:day:'||t.guild_id||':'||to_char(day_start at time zone 'UTC','YYYY-MM-DD'),0));
    n:=clock_timestamp();
    if n>=t.deadline or n>=day_start+interval '1 day' then return null; end if;
    select count(*) into used from public.usage_reservation where guild_id=t.guild_id
      and reserved_at>=day_start and reserved_at<day_start+interval '1 day';
    if used>=cap then continue; end if;
    -- One shared guild/day gate includes every provider and earlier installation generation.
    perform pg_advisory_xact_lock(hashtextextended('yuna:money:day:'||t.guild_id||':'||to_char(day_start at time zone 'UTC','YYYY-MM-DD'),0));
    select value into money from jsonb_array_elements(policy.limits::jsonb)
      where value->>'budgetKey'='guild.daily-money' and value->'allowance'->>'mode'='limited' limit 1;
    select value into price from jsonb_array_elements(policy.per_attempt_bounds::jsonb)
      where value->>'provider'=provider_name and value->>'modelRoute'=p_model limit 1;
    reserved:=0; pricing:='unpriced-bounded-units-v1'; currency_code:='USD';
    if price is not null then
      if not coalesce(price->>'maxCost' ~ '^(0|[1-9][0-9]{0,19})([.][0-9]{1,18})?$',false)
        or not coalesce(price->>'inputPerMillion' ~ '^(0|[1-9][0-9]{0,19})([.][0-9]{1,18})?$',false)
        or not coalesce(price->>'outputPerMillion' ~ '^(0|[1-9][0-9]{0,19})([.][0-9]{1,18})?$',false)
        or not coalesce(price->>'maxInputTokens' ~ '^[1-9][0-9]{0,5}$',false)
        or (price->>'maxInputTokens')::integer<65536
        or not coalesce(price->>'maxOutputTokens' ~ '^[1-9][0-9]{0,3}$',false)
        or (price->>'maxOutputTokens')::integer<(case p_kind when 'moderation.observe' then 1024 else 4096 end)
        or not coalesce(length(price->>'pricingVersion') between 1 and 512,false)
        or not coalesce(price->>'currency' ~ '^[A-Z]{3}$',false) then continue; end if;
      reserved:=(price->>'maxCost')::numeric; pricing:=price->>'pricingVersion'; currency_code:=price->>'currency';
      if reserved < ((price->>'inputPerMillion')::numeric*(price->>'maxInputTokens')::numeric
        + (price->>'outputPerMillion')::numeric*(price->>'maxOutputTokens')::numeric)/1000000 then continue; end if;
    end if;
    if provider_name='openrouter' and currency_code<>'USD' then continue; end if;
    if money is not null then
      if price is null or money->'allowance'->>'currency'<>currency_code then continue; end if;
      -- Unknown old prices/currencies cannot be counted as free when enabling a monetary cap.
      if exists(select 1 from public.usage_reservation u where u.guild_id=t.guild_id
        and u.reserved_at>=day_start and u.reserved_at<day_start+interval '1 day' and u.state<>'released'
        and (u.currency<>currency_code or (u.state in ('reserved','liability') and u.pricing_version='unpriced-bounded-units-v1'))) then continue; end if;
      select coalesce(sum(case when u.state='released' then 0 when u.state='settled' then coalesce(e.actual_cost,u.reserved_cost)
        else u.reserved_cost end),0) into committed from public.usage_reservation u
        left join public.usage_entry e on e.reservation_id=u.id where u.guild_id=t.guild_id
        and u.reserved_at>=day_start and u.reserved_at<day_start+interval '1 day';
      if committed+reserved>(money->'allowance'->>'amount')::numeric then continue; end if;
    end if;
    n:=clock_timestamp();
    if n>=t.deadline or n>=day_start+interval '1 day' then return null; end if;
    attempt_id:=gen_random_uuid(); reservation_id:=gen_random_uuid(); gen:=t.execution_generation+1;
    lease:=least(t.deadline,n+interval '120 seconds');
    insert into public.usage_reservation
      (id,created_at,installation_id,guild_id,feature,provider,model_route,operation_kind,operation_key,task_id,attempt_number,
       attempt_id,reserved_units,reserved_cost,currency,usage_policy_id,policy_revision,policy_snapshot,pricing_version,
       budget_windows,state,reserved_at,reconcile_after,row_revision,updated_at,purge_after)
    values (reservation_id,n,t.installation_id,t.guild_id,'moderation',provider_name,p_model,'task-attempt',t.id::text||':1',t.id,1,
      attempt_id,jsonb_build_object('requests',1,'input_bytes',32768,'output_tokens',case p_kind when 'moderation.observe' then 1024 else 4096 end),
      reserved,currency_code,policy.id,policy.policy_revision,jsonb_build_object('dailyAttemptLimit',cap,'monetaryEstimateAvailable',price is not null,'pricing',price),
      pricing,jsonb_build_array(jsonb_build_object('key',budget_key,'startsAt',day_start,'endsAt',day_start+interval '1 day')),
      'reserved',n,n+interval '1 day',1,n,n+make_interval(days => coalesce(
        (select (operator_policy->'retention'->>'accountingDays')::integer from public.guild_installation where id=t.installation_id),30)));
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


create function public.yuna_moderation_release(p_task uuid,p_attempt uuid,p_generation integer,p_executor text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; a public.task_attempt; n timestamptz; payload jsonb;
begin
  if p_task is null or p_attempt is null or p_generation is null or p_generation<1 or p_executor is null then return null; end if;
  if not public.yuna_moderation_gate(p_task) then return null; end if;
  select * into t from public.ai_task where id=p_task;
  select * into a from public.task_attempt where id=p_attempt and task_id=t.id for update;
  n:=clock_timestamp();
  if a.id is null or t.state<>'RUNNING' or t.active_attempt_id<>a.id or t.execution_generation<>p_generation
    or a.generation<>p_generation or a.executor_id<>p_executor or a.state<>'claimed' or n>=a.lease_until or n>=t.deadline then return null; end if;
  update public.task_attempt set state='released',input_released_at=n,row_revision=row_revision+1,updated_at=n where id=a.id;
  select p.payload into payload from public.prepared_input p where p.id=t.prepared_input_id;
  return payload;
end $$;


create function public.yuna_moderation_start(p_task uuid,p_attempt uuid,p_generation integer,p_executor text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; a public.task_attempt; n timestamptz;
begin
  if p_task is null or p_attempt is null or p_generation is null or p_generation<1 or p_executor is null then return false; end if;
  if not public.yuna_moderation_gate(p_task) then return false; end if;
  select * into t from public.ai_task where id=p_task;
  select * into a from public.task_attempt where id=p_attempt and task_id=t.id for update;
  n:=clock_timestamp();
  if a.id is null or t.state<>'RUNNING' or t.active_attempt_id<>a.id or t.execution_generation<>p_generation
    or a.generation<>p_generation or a.executor_id<>p_executor or a.state<>'released' or n>=a.lease_until or n>=t.deadline then return false; end if;
  update public.task_attempt set state='executing',started_at=n,row_revision=row_revision+1,updated_at=n where id=a.id;
  return true;
end $$;


-- Accept only known capability envelopes; owner acceptance revalidates semantic evidence bindings separately.
create function public.yuna_moderation_finish(p_task uuid,p_attempt uuid,p_generation integer,p_executor text,p_result jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; a public.task_attempt; n timestamptz; eligible boolean; live boolean;
  result_outcome text; reason text; payload jsonb; usage jsonb; provider_ref text; value text; reported_cost numeric;
  u public.usage_reservation; prior_cost numeric; cost_already_reported boolean:=false;
begin
  if p_task is null or p_attempt is null or p_generation is null or p_generation<1 or p_executor is null then return false; end if;
  if p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>65536 then raise exception 'Invalid moderation outcome' using errcode='22023'; end if;
  result_outcome:=p_result->>'outcome'; reason:=p_result->>'reason'; payload:=p_result->'payload'; usage:=p_result->'usage';
  provider_ref:=coalesce(p_result->>'providerRequestId',payload->>'providerRequestId');
  if result_outcome is null or result_outcome not in ('success','failure','uncertain') or reason is null or reason !~ '^[a-z0-9_.-]{1,120}$'
    or (provider_ref is not null and length(provider_ref) not between 1 and 512) then raise exception 'Invalid moderation outcome' using errcode='22023'; end if;
  eligible:=public.yuna_moderation_gate(p_task);
  select * into t from public.ai_task where id=p_task;
  select * into a from public.task_attempt where id=p_attempt and task_id=p_task for update;
  if t.id is null or t.owner<>'moderation' or t.kind not in ('moderation.observe','moderation.assess') or t.schema_version<>1 or a.id is null
    or a.executor_id<>p_executor or a.generation<>p_generation then return false; end if;
  if usage is not null then
    if jsonb_typeof(usage)<>'object' then raise exception 'Invalid moderation usage' using errcode='22023'; end if;
    foreach value in array array['inputTokens','outputTokens','totalTokens'] loop
      if jsonb_typeof(usage->value) is distinct from 'number' or not coalesce(usage->>value ~ '^(0|[1-9][0-9]{0,9})$',false)
        or (usage->>value)::numeric>2147483647 then raise exception 'Invalid moderation usage' using errcode='22023'; end if;
    end loop;
    if (usage->>'totalTokens')::bigint<>(usage->>'inputTokens')::bigint+(usage->>'outputTokens')::bigint then raise exception 'Inconsistent moderation usage' using errcode='22023'; end if;
    if usage ? 'costUsd' then
      if t.kind<>'moderation.assess' or jsonb_typeof(usage->'costUsd') is distinct from 'string'
        or not coalesce(usage->>'costUsd' ~ '^(0|[1-9][0-9]{0,19})([.][0-9]{1,18})?$',false) then raise exception 'Invalid reported moderation cost' using errcode='22023'; end if;
      reported_cost:=(usage->>'costUsd')::numeric;
    end if;
  end if;
  if result_outcome='success' then
    if a.started_at is null or payload is null or jsonb_typeof(payload)<>'object' or payload->>'schemaVersion'<>'1'
      or payload->>'requestedModel' is distinct from t.model_version or jsonb_typeof(payload->'model') is distinct from 'string'
      or length(payload->>'model') not between 1 and 512 or usage is null
      or payload->'inputTokens' is distinct from usage->'inputTokens' or payload->'outputTokens' is distinct from usage->'outputTokens'
      or payload->'totalTokens' is distinct from usage->'totalTokens'
      or jsonb_typeof(payload->'sourceReferences') is distinct from 'array'
      or payload->'sourceReferences' is distinct from jsonb_build_array('evidence:'||(t.validity_bindings->>'evidenceRevisionId')) then
      raise exception 'Invalid moderation capability result' using errcode='22023'; end if;
    if t.kind='moderation.observe' then
      if payload->>'outcome' not in ('observed','uncertain') or payload->>'outcome' is null
        or payload->>'evidenceRevisionId' is distinct from t.validity_bindings->>'evidenceRevisionId'
        or jsonb_typeof(payload->'inspectedBody') is distinct from 'boolean' or jsonb_typeof(payload->'facts') is distinct from 'array'
        or jsonb_array_length(payload->'facts')>20 or jsonb_typeof(payload->'limitations') is distinct from 'array'
        or jsonb_array_length(payload->'limitations')>20 or (usage->>'outputTokens')::integer>1024 then
        raise exception 'Invalid original observation' using errcode='22023'; end if;
    else
      if payload->>'outcome' not in ('assessed','uncertain') or payload->>'outcome' is null
        or payload->>'configurationVersion' is distinct from t.validity_bindings->>'policyRevisionId'
        or jsonb_typeof(payload->'answers') is distinct from 'object' or reported_cost is null
        or payload->'costUsd' is distinct from usage->'costUsd' then raise exception 'Invalid moderation assessment' using errcode='22023'; end if;
    end if;
  else payload:=null; end if;
  if usage is not null and a.input_released_at is null then raise exception 'Usage requires released input' using errcode='22023'; end if;
  if reported_cost is not null then
    select * into u from public.usage_reservation where id=a.reservation_id for update;
    if u.provider<>'openrouter' or u.currency<>'USD' then raise exception 'Reported cost currency does not match reservation' using errcode='22023'; end if;
    cost_already_reported:=u.resolution_reason='provider_reported_usd';
    if cost_already_reported then
      select actual_cost into prior_cost from public.usage_entry where reservation_id=u.id;
      if prior_cost is distinct from reported_cost then raise exception 'Conflicting reported moderation cost' using errcode='22023'; end if;
    end if;
  end if;
  n:=clock_timestamp();
  perform public.yuna_conversation_account(a.id,usage,provider_ref,'timeout',n);
  -- Decisions reports exact decimal USD cost; keep it even if a late result cannot be published.
  if reported_cost is not null and not coalesce(cost_already_reported,false) then
    select * into u from public.usage_reservation where id=a.reservation_id for update;
    if u.provider<>'openrouter' or u.currency<>'USD' then raise exception 'Reported cost currency does not match reservation' using errcode='22023'; end if;
    update public.usage_entry set accounting_state='actual',actual_cost=reported_cost,reconcile_after=null,
      provider_request_id=coalesce(provider_ref,provider_request_id),last_evidence_at=n,row_revision=row_revision+1,updated_at=n
      where reservation_id=u.id and accounting_state in ('estimated','actual');
    update public.usage_reservation set state='settled',settled_at=coalesce(settled_at,n),resolution_reason='provider_reported_usd',
      resolution_evidence=jsonb_build_object('kind','provider_response','reference',coalesce(provider_ref,a.id::text),'observedAt',n),
      row_revision=row_revision+1,updated_at=n where id=u.id and state in ('reserved','liability','settled');
  end if;
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

-- Recover lost claims without provider retry; released unknown work retains accounting liability.
create function public.yuna_moderation_recover(p_limit integer) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare candidate uuid; t public.ai_task; a public.task_attempt; eligible boolean; n timestamptz; recovered integer:=0; terminal_outcome text;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid recovery batch' using errcode='22023'; end if;
  for candidate in select id from public.ai_task where state<>'TERMINAL' and kind in ('moderation.observe','moderation.assess') and owner='moderation' and schema_version=1
    order by deadline,created_at,id limit p_limit loop
    eligible:=public.yuna_moderation_gate(candidate);
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

revoke all on function public.yuna_moderation_gate(uuid) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_moderation_claim(text,text,text) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_moderation_release(uuid,uuid,integer,text) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_moderation_start(uuid,uuid,integer,text) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_moderation_finish(uuid,uuid,integer,text,jsonb) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_moderation_recover(integer) from public,yuna_bot,yuna_worker;
grant execute on function public.yuna_moderation_claim(text,text,text) to yuna_worker;
grant execute on function public.yuna_moderation_release(uuid,uuid,integer,text) to yuna_worker;
grant execute on function public.yuna_moderation_start(uuid,uuid,integer,text) to yuna_worker;
grant execute on function public.yuna_moderation_finish(uuid,uuid,integer,text,jsonb) to yuna_worker;
grant execute on function public.yuna_moderation_recover(integer) to yuna_bot;
