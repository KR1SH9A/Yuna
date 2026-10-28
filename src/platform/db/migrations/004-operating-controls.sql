-- Extend conversation accounting without rewriting earlier migration checksums.
-- Price snapshots use exact decimal strings/numeric arithmetic; unknown spend remains reserved.
-- Runtime roles gain no new SQL entry points; these replace already restricted implementations.

-- Persist only operator-approved policy. Worker entry points remain restricted.
alter table public.guild_installation add column if not exists operator_policy jsonb null;
alter table public.guild_installation add column if not exists policy_revision integer not null default 0;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.guild_installation'::regclass and conname='guild_installation_policy_revision_check') then
    alter table public.guild_installation add constraint guild_installation_policy_revision_check check(policy_revision >= 0);
  end if;
end $$;

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
    and p.expires_at is not null and n < p.expires_at and n < p.purge_after, false);
end $$;

create or replace function public.yuna_conversation_account(p_attempt uuid, p_usage jsonb, p_provider_ref text, p_kind text, p_now timestamptz)
returns void language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  a public.task_attempt; u public.usage_reservation; prior public.usage_entry;
  units jsonb; new_evidence jsonb; no_dispatch boolean; price jsonb; actual numeric;
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
  -- Settle measured units using the immutable admitted price, never today's replacement price.
  price:=u.policy_snapshot->'pricing';
  if not no_dispatch and p_usage is not null and price is not null and price<>'null'::jsonb then
    actual:=ceil((((price->>'inputPerMillion')::numeric*(p_usage->>'inputTokens')::numeric
      +(price->>'outputPerMillion')::numeric*(p_usage->>'outputTokens')::numeric)/1000000)*1e18)/1e18;
    update public.usage_entry set accounting_state='actual',actual_cost=actual,reported_units=units,
      provider_request_id=coalesce(p_provider_ref,provider_request_id),reconcile_after=null,
      last_evidence_at=p_now,row_revision=row_revision+1,updated_at=p_now
      where reservation_id=u.id and accounting_state='estimated';
    update public.usage_reservation set state='settled',settled_at=p_now,resolution_reason='provider_response',
      resolution_evidence=new_evidence,row_revision=row_revision+1,updated_at=p_now
      where id=u.id and state in ('reserved','liability');
  end if;
end $$;


create or replace function public.yuna_conversation_claim(p_executor text, p_model text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  candidate uuid; t public.ai_task; p public.prepared_input; policy public.usage_policy;
  n timestamptz; day_start timestamptz; cap integer; used bigint; budget_key text;
  attempt_id uuid; reservation_id uuid; lease timestamptz; gen integer;
  money jsonb; price jsonb; reserved numeric; committed numeric; pricing text; currency_code text;
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
      where value->>'provider'='deepseek' and value->>'modelRoute'=p_model limit 1;
    reserved:=0; pricing:='unpriced-bounded-units-v1'; currency_code:='USD';
    if price is not null then
      if not coalesce(price->>'maxCost' ~ '^(0|[1-9][0-9]{0,19})([.][0-9]{1,18})?$',false)
        or not coalesce(price->>'inputPerMillion' ~ '^(0|[1-9][0-9]{0,19})([.][0-9]{1,18})?$',false)
        or not coalesce(price->>'outputPerMillion' ~ '^(0|[1-9][0-9]{0,19})([.][0-9]{1,18})?$',false)
        or not coalesce(price->>'maxInputTokens' ~ '^[1-9][0-9]{0,5}$',false)
        or (price->>'maxInputTokens')::integer<32768
        or not coalesce(price->>'maxOutputTokens' ~ '^[1-9][0-9]{0,3}$',false)
        or (price->>'maxOutputTokens')::integer<(p.payload->>'maxOutputTokens')::integer
        or not coalesce(length(price->>'pricingVersion') between 1 and 512,false)
        or not coalesce(price->>'currency' ~ '^[A-Z]{3}$',false) then continue; end if;
      reserved:=(price->>'maxCost')::numeric; pricing:=price->>'pricingVersion'; currency_code:=price->>'currency';
      if reserved < ((price->>'inputPerMillion')::numeric*(price->>'maxInputTokens')::numeric
        + (price->>'outputPerMillion')::numeric*(price->>'maxOutputTokens')::numeric)/1000000 then continue; end if;
    end if;
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
    if not public.yuna_usage_user_gate(t.id,reserved,currency_code,price is not null) then continue; end if;
    n:=clock_timestamp();
    if n>=t.deadline or n>=day_start+interval '1 day' then return null; end if;
    attempt_id:=gen_random_uuid(); reservation_id:=gen_random_uuid(); gen:=t.execution_generation+1;
    lease:=least(t.deadline,n+interval '120 seconds');
    insert into public.usage_reservation
      (id,created_at,installation_id,guild_id,feature,provider,model_route,operation_kind,operation_key,task_id,attempt_number,
       attempt_id,reserved_units,reserved_cost,currency,usage_policy_id,policy_revision,policy_snapshot,pricing_version,
       budget_windows,state,reserved_at,reconcile_after,row_revision,updated_at,purge_after)
    values (reservation_id,n,t.installation_id,t.guild_id,'community','deepseek',p_model,'task-attempt',t.id::text||':1',t.id,1,
      attempt_id,jsonb_build_object('requests',1,'input_characters',4000,'previous_reply_characters',2000,'output_tokens',(p.payload->>'maxOutputTokens')::integer),
      reserved,currency_code,policy.id,policy.policy_revision,jsonb_build_object('dailyAttemptLimit',cap,'monetaryEstimateAvailable',price is not null,'pricing',price,'userId',public.yuna_usage_task_user(t.id)),
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

