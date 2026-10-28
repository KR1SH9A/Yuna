-- Personal usage preferences belong to the requesting member, never a moderation subject.
-- Claims already hold the guild/day budget locks; changing a preference takes those same locks.
-- All money stays exact numeric and unresolved/unpriced attempts never become free spend.
create table public.user_usage_limit (
  guild_id text not null,
  user_id text not null,
  installation_id uuid not null,
  daily_attempt_limit integer null check(daily_attempt_limit between 0 and 1000000),
  daily_budget numeric(38,18) null check(daily_budget>=0),
  currency text null check(currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz not null,
  primary key(guild_id,user_id),
  check((daily_budget is null)=(currency is null)),
  foreign key(installation_id,guild_id) references public.guild_installation(id,guild_id)
);
revoke all on table public.user_usage_limit from public,yuna_bot,yuna_worker;

-- Resolve the requester from intake identity captured by the gateway, not from model output or prompt text.
create function public.yuna_usage_task_user(p_task uuid) returns text
language sql stable set search_path=pg_catalog,public,pg_temp as $$
  select coalesce(e.request_actor_id,e.author_user_id) from public.ai_task t
  join public.intake_event e on e.id=(t.validity_bindings->>'sourceEventId')::uuid
    and e.installation_id=t.installation_id and e.guild_id=t.guild_id
  where t.id=p_task and t.owner='community' and e.author_kind='user'
$$;

-- Called inside the claim transaction before reservation insertion; the shared guild/day lock prevents overspend races.
create function public.yuna_usage_user_gate(p_task uuid,p_cost numeric,p_currency text,p_priced boolean) returns boolean
language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare t public.ai_task; actor text; defaults jsonb; personal public.user_usage_limit;
  cap integer; amount numeric; currency_code text; used bigint; committed numeric; start_at timestamptz;
begin
  select * into t from public.ai_task where id=p_task;
  if not found or t.owner not in ('community','debates') then return false; end if;
  actor:=public.yuna_usage_task_user(p_task);
  select operator_policy->'usage'->'userDefaults' into defaults from public.guild_installation where id=t.installation_id;
  select * into personal from public.user_usage_limit where guild_id=t.guild_id and user_id=actor;
  if defaults is null and personal.user_id is null then return true; end if;
  if actor is null then return false; end if;
  cap:=least((defaults->>'dailyAttemptLimit')::integer,personal.daily_attempt_limit);
  start_at:=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC';
  select count(*) into used from public.usage_reservation where guild_id=t.guild_id
    and policy_snapshot->>'userId'=actor and reserved_at>=start_at and reserved_at<start_at+interval '1 day';
  if cap is not null and used>=cap then return false; end if;
  currency_code:=coalesce(defaults->'dailyBudget'->>'currency',personal.currency);
  amount:=least((defaults->'dailyBudget'->>'amount')::numeric,personal.daily_budget);
  if amount is null then return true; end if;
  if not p_priced or p_currency<>currency_code or (personal.currency is not null and personal.currency<>currency_code) then return false; end if;
  if exists(select 1 from public.usage_reservation u where u.guild_id=t.guild_id and u.policy_snapshot->>'userId'=actor
    and u.reserved_at>=start_at and u.reserved_at<start_at+interval '1 day' and u.state<>'released'
    and (u.currency<>currency_code or (u.state in ('reserved','liability') and u.pricing_version='unpriced-bounded-units-v1'))) then return false; end if;
  select coalesce(sum(case when u.state='released' then 0 when u.state='settled' then coalesce(e.actual_cost,u.reserved_cost)
    else u.reserved_cost end),0) into committed from public.usage_reservation u
    left join public.usage_entry e on e.reservation_id=u.id where u.guild_id=t.guild_id and u.policy_snapshot->>'userId'=actor
    and u.reserved_at>=start_at and u.reserved_at<start_at+interval '1 day';
  return committed+p_cost<=amount;
end $$;
revoke all on function public.yuna_usage_task_user(uuid) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_usage_user_gate(uuid,numeric,text,boolean) from public,yuna_bot,yuna_worker;
