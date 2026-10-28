-- Activate consented explicit-submission Debates; grant no worker access to source tables.
create table "debate_evaluation" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "acceptance_operation_key" text not null, "session_id" uuid not null, "transcript_snapshot_id" uuid not null, "rubric_revision_id" uuid not null, "accepted_results" jsonb not null, "criterion_scores" jsonb null, "evidence_references" jsonb null, "totals" jsonb null, "outcome" jsonb null, "limitations" jsonb null, "accepted_at" timestamptz not null, "publication_state" text not null, "publication_destination" jsonb not null, "publication_message_id" text null, "published_at" timestamptz null, "publication_attempt" jsonb null, "row_revision" int not null, "updated_at" timestamptz not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
alter table "debate_evaluation" add constraint "debate_evaluation_installation_id_guild_id_accept_a9229_unique" unique ("installation_id", "guild_id", "acceptance_operation_key");
alter table "debate_evaluation" add constraint "debate_evaluation_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "debate_evaluation" add constraint "debate_evaluation_check_3" check ("row_revision" >= 1);
alter table "debate_evaluation" add constraint "debate_evaluation_check_2" check (("publication_state" = 'published') = ("publication_message_id" is not null and "published_at" is not null));
alter table "debate_evaluation" add constraint "debate_evaluation_check_1" check ("publication_state" in ('pending', 'claimed', 'unknown', 'published', 'failed', 'canceled'));
create table "debate_session" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "source_request_id" text not null, "source_operation_key" text not null, "channel_id" text not null, "topic" text null, "invited_user_ids" jsonb not null, "scope_revision" int not null, "consent_scope" jsonb not null, "state" text not null, "rubric_revision_id" uuid not null, "frozen_transcript_id" uuid null, "expected_evaluation_tasks" jsonb not null, "accepted_evaluation_id" uuid null, "cancellation_generation" int not null, "started_at" timestamptz null, "frozen_at" timestamptz null, "canceled_at" timestamptz null, "row_revision" int not null, "updated_at" timestamptz not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
alter table "debate_session" add constraint "debate_session_installation_id_guild_id_source_re_dd02d_unique" unique ("installation_id", "guild_id", "source_request_id", "source_operation_key");
alter table "debate_session" add constraint "debate_session_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "debate_session" add constraint "debate_session_check_4" check ("row_revision" >= 1);
alter table "debate_session" add constraint "debate_session_check_3" check ("state" <> 'evaluated' or "accepted_evaluation_id" is not null);
alter table "debate_session" add constraint "debate_session_check_2" check ("state" not in ('frozen', 'evaluating', 'evaluated') or "frozen_transcript_id" is not null);
alter table "debate_session" add constraint "debate_session_check_1" check ("state" in ('proposed', 'active', 'frozen', 'evaluating', 'evaluated', 'canceled'));
create table "participant_consent" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "session_id" uuid not null, "user_id" text not null, "scope_revision" int not null, "accepted_scope" jsonb not null, "scope_hash" text not null, "accepted_at" timestamptz not null, "source_request_id" text not null, "withdrawn_at" timestamptz null, "withdrawal_reason" text null, "row_revision" int not null, "updated_at" timestamptz not null, "purge_after" timestamptz not null, primary key ("id"));
alter table "participant_consent" add constraint "participant_consent_installation_id_guild_id_sour_669d5_unique" unique ("installation_id", "guild_id", "source_request_id");
alter table "participant_consent" add constraint "participant_consent_installation_id_guild_id_sess_bd512_unique" unique ("installation_id", "guild_id", "session_id", "user_id", "scope_revision");
alter table "participant_consent" add constraint "participant_consent_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "participant_consent" add constraint "participant_consent_check_2" check ("row_revision" >= 1);
alter table "participant_consent" add constraint "participant_consent_check_1" check ("withdrawn_at" is null or "withdrawn_at" >= "accepted_at");
create table "rubric_revision" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "rubric_id" uuid not null, "revision" int not null, "criteria" jsonb null, "weights" jsonb null, "configuration_versions" jsonb null, "outcome_rules" jsonb null, "activated_at" timestamptz null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
alter table "rubric_revision" add constraint "rubric_revision_installation_id_guild_id_rubric_i_d25a8_unique" unique ("installation_id", "guild_id", "rubric_id", "revision");
alter table "rubric_revision" add constraint "rubric_revision_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "rubric_revision" add constraint "rubric_revision_check_1" check ("revision" >= 0);
create table "transcript_entry" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "session_id" uuid not null, "sequence" int not null, "kind" text not null, "source_event_key" text not null, "message_id" text null, "author_id" text null, "source_created_at" timestamptz null, "source_edited_at" timestamptz null, "captured_at" timestamptz not null, "content" jsonb null, "artifact_ids" jsonb not null, "content_hash" text null, "coverage" jsonb not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
create index "transcript_entry_purge_after_index" on "transcript_entry" ("purge_after");
alter table "transcript_entry" add constraint "transcript_entry_installation_id_guild_id_session_64a62_unique" unique ("installation_id", "guild_id", "session_id", "source_event_key");
alter table "transcript_entry" add constraint "transcript_entry_installation_id_guild_id_session_67091_unique" unique ("installation_id", "guild_id", "session_id", "sequence");
alter table "transcript_entry" add constraint "transcript_entry_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "transcript_entry" add constraint "transcript_entry_check_2" check ("kind" in ('message', 'edit', 'deletion', 'gap', 'submission'));
alter table "transcript_entry" add constraint "transcript_entry_check_1" check ("sequence" > 0);
create table "transcript_snapshot" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "session_id" uuid not null, "revision" int not null, "ordered_entry_ids" jsonb null, "content_hash" text not null, "declared_coverage" jsonb not null, "gaps" jsonb null, "frozen_at" timestamptz not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
alter table "transcript_snapshot" add constraint "transcript_snapshot_installation_id_guild_id_sess_13d8e_unique" unique ("installation_id", "guild_id", "session_id", "revision");
alter table "transcript_snapshot" add constraint "transcript_snapshot_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "transcript_snapshot" add constraint "transcript_snapshot_check_1" check ("revision" >= 0);
alter table "transcript_snapshot" add constraint "transcript_snapshot_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "transcript_snapshot" add constraint "transcript_snapshot_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "transcript_entry" add constraint "transcript_entry_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "transcript_entry" add constraint "transcript_entry_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "rubric_revision" add constraint "rubric_revision_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "rubric_revision" add constraint "rubric_revision_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "participant_consent" add constraint "participant_consent_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "participant_consent" add constraint "participant_consent_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "debate_session" add constraint "debate_session_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "debate_session" add constraint "debate_session_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "debate_evaluation" add constraint "debate_evaluation_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "debate_evaluation" add constraint "debate_evaluation_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "debate_session" add constraint "debate_session_rubric_revision_id_scope_fk" foreign key ("installation_id", "guild_id", "rubric_revision_id") references "rubric_revision" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "debate_session" add constraint "debate_session_frozen_transcript_id_scope_fk" foreign key ("installation_id", "guild_id", "frozen_transcript_id") references "transcript_snapshot" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "debate_session" add constraint "debate_session_accepted_evaluation_id_scope_fk" foreign key ("installation_id", "guild_id", "accepted_evaluation_id") references "debate_evaluation" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "participant_consent" add constraint "participant_consent_session_id_scope_fk" foreign key ("installation_id", "guild_id", "session_id") references "debate_session" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "transcript_entry" add constraint "transcript_entry_session_id_scope_fk" foreign key ("installation_id", "guild_id", "session_id") references "debate_session" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "transcript_snapshot" add constraint "transcript_snapshot_session_id_scope_fk" foreign key ("installation_id", "guild_id", "session_id") references "debate_session" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "debate_evaluation" add constraint "debate_evaluation_session_id_scope_fk" foreign key ("installation_id", "guild_id", "session_id") references "debate_session" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "debate_evaluation" add constraint "debate_evaluation_transcript_snapshot_id_scope_fk" foreign key ("installation_id", "guild_id", "transcript_snapshot_id") references "transcript_snapshot" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "debate_evaluation" add constraint "debate_evaluation_rubric_revision_id_scope_fk" foreign key ("installation_id", "guild_id", "rubric_revision_id") references "rubric_revision" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;

alter table debate_session add constraint debate_consent_identity unique (installation_id, guild_id, id, scope_revision);
alter table participant_consent add constraint participant_exact_scope_fk
  foreign key (installation_id, guild_id, session_id, scope_revision)
  references debate_session (installation_id, guild_id, id, scope_revision)
  on delete no action deferrable initially deferred;


alter table transcript_snapshot add constraint snapshot_session_identity unique (installation_id, guild_id, session_id, id);
alter table debate_session add constraint debate_frozen_session_fk
  foreign key (installation_id, guild_id, id, frozen_transcript_id)
  references transcript_snapshot (installation_id, guild_id, session_id, id)
  on delete no action deferrable initially deferred;


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


-- Always lock installation, safety and session before task/attempt rows, including rejected work.
create function public.yuna_debate_gate(p_task uuid) returns boolean
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; i public.guild_installation; safety public.guild_safety_state;
  s public.debate_session; snapshot public.transcript_snapshot; rubric public.rubric_revision; p public.prepared_input; n timestamptz;
begin
  select * into t from public.ai_task where id=p_task;
  if not found or t.owner<>'debates' or t.kind<>'debates.assess' or t.schema_version<>1 then return false; end if;
  select * into i from public.guild_installation where id=t.installation_id and guild_id=t.guild_id for update;
  select * into safety from public.guild_safety_state where installation_id=t.installation_id and guild_id=t.guild_id for update;
  select * into s from public.debate_session where id=t.workflow_id and installation_id=t.installation_id and guild_id=t.guild_id for update;
  select * into snapshot from public.transcript_snapshot where id=s.frozen_transcript_id and session_id=s.id and installation_id=t.installation_id and guild_id=t.guild_id;
  select * into rubric from public.rubric_revision where id=s.rubric_revision_id and installation_id=t.installation_id and guild_id=t.guild_id;
  select * into t from public.ai_task where id=p_task for update;
  select * into p from public.prepared_input where id=t.prepared_input_id and task_id=t.id for update;
  n:=clock_timestamp();
  return coalesce(i.state='active' and i.discord_availability='available' and i.feature_admission->>'debates' in ('enabled','read_only')
    and safety.id is not null and not safety.paused and safety.safety_revision=(t.validity_bindings->>'safetyRevision')::integer
    and s.state='evaluating' and s.canceled_at is null and s.payload_purged_at is null and n<s.purge_after
    and s.expected_evaluation_tasks->>t.expected_variant=t.id::text and t.expected_variant in ('original','reversed')
    and s.cancellation_generation=(t.validity_bindings->>'ownerRevision')::integer
    and s.scope_revision=(t.validity_bindings->>'privacyRevision')::integer and t.stage='evaluating'
    and s.consent_scope->>'submissionMode'='explicit_text' and s.consent_scope->>'assessmentModel'=t.model_version
    and jsonb_array_length(s.invited_user_ids)=2
    and not exists(select 1 from jsonb_array_elements_text(s.invited_user_ids) person(user_id) where not exists(
      select 1 from public.participant_consent c where c.installation_id=s.installation_id and c.guild_id=s.guild_id and c.session_id=s.id
        and c.user_id=person.user_id and c.scope_revision=s.scope_revision and c.accepted_scope=s.consent_scope
        and c.scope_hash=p.provenance->>'consentScopeHash' and c.withdrawn_at is null and c.accepted_at<=n and n<c.purge_after))
    and snapshot.id=(t.validity_bindings->>'transcriptSnapshotId')::uuid and snapshot.payload_purged_at is null and n<snapshot.purge_after
    and snapshot.declared_coverage->>'complete'='true' and jsonb_array_length(snapshot.ordered_entry_ids) between 2 and 20
    and not exists(select 1 from jsonb_array_elements_text(snapshot.ordered_entry_ids) item(id) left join public.transcript_entry e
      on e.id=item.id::uuid and e.session_id=s.id and e.installation_id=s.installation_id and e.guild_id=s.guild_id
      where e.id is null or e.kind<>'submission' or e.payload_purged_at is not null or n>=e.purge_after or e.content->>'text' is null
        or e.content->>'contentAccess'<>'available' or e.coverage->>'complete'<>'true' or not (s.invited_user_ids @> jsonb_build_array(e.author_id)))
    and rubric.id=(t.validity_bindings->>'rubricRevisionId')::uuid and rubric.payload_purged_at is null and n<rubric.purge_after
    and rubric.configuration_versions->>'model'=t.model_version and (t.expected_variant='original' or rubric.configuration_versions->>'paired'='true')
    and t.source_use='none' and t.deadline is not null and n<t.deadline
    and p.eligible and p.payload is not null and p.cleanup_state='retained' and p.content_hash=t.input_hash and p.validity_bindings=t.validity_bindings
    and p.schema_version=1 and p.payload->>'kind'='debates.assess' and p.payload->'input'->>'configurationVersion'=rubric.id::text
    and p.payload->'input'->'sourceReferences'=jsonb_build_array('transcript:'||snapshot.id::text||':'||snapshot.content_hash)
    and p.expires_at is not null and n<p.expires_at and n<p.purge_after,false);
end $$;

-- Charge an explicitly consented Debate to its initiating participant; automated moderation has no personal payer.
create or replace function public.yuna_usage_task_user(p_task uuid) returns text
language sql stable set search_path=pg_catalog,public,pg_temp as $$
  select coalesce(e.request_actor_id,e.author_user_id) from public.ai_task t
  join public.intake_event e on e.id=(t.validity_bindings->>'sourceEventId')::uuid
    and e.installation_id=t.installation_id and e.guild_id=t.guild_id
  where t.id=p_task and t.owner='community' and e.author_kind='user'
  union all
  select s.invited_user_ids->>0 from public.ai_task t join public.debate_session s
    on s.id=t.workflow_id and s.installation_id=t.installation_id and s.guild_id=t.guild_id
  where t.id=p_task and t.owner='debates' and t.kind='debates.assess'
$$;
revoke all on function public.yuna_usage_task_user(uuid) from public,yuna_bot,yuna_worker;

-- Reserve one consented attempt under shared guild and personal daily caps before creating a worker lease.
create function public.yuna_debate_claim(p_executor text, p_model text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  p_kind text:='debates.assess'; candidate uuid; t public.ai_task; p public.prepared_input; policy public.usage_policy;
  n timestamptz; day_start timestamptz; cap integer; used bigint; budget_key text;
  attempt_id uuid; reservation_id uuid; lease timestamptz; gen integer;
  provider_name text; money jsonb; price jsonb; reserved numeric; committed numeric; pricing text; currency_code text;
begin
  if p_executor is null or length(p_executor) not between 1 and 256
    or p_model is null or length(p_model) not between 1 and 512 then raise exception 'Invalid worker routing' using errcode='22023'; end if;
  if p_kind is null or p_kind not in ('debates.assess') then raise exception 'Unsupported debate capability' using errcode='22023'; end if;
  provider_name:='openrouter';
  for candidate in select id from public.ai_task where state='READY' and kind=p_kind
    and schema_version=1 and owner='debates' and model_version=p_model and deadline>clock_timestamp()
    order by created_at,id limit 50 loop
    if not public.yuna_debate_gate(candidate) then continue; end if;
    select * into t from public.ai_task where id=candidate;
    if t.state<>'READY' or t.attempt_count<>0 or t.max_attempts<>1 or t.model_version<>p_model
      or t.provider_configuration_version<>'openrouter-decisions-v1' then continue; end if;
    n := clock_timestamp();
    if n>=t.deadline then continue; end if;
    select * into p from public.prepared_input where id=t.prepared_input_id;
    if p.payload->>'schemaVersion'<>'1' or p.payload->>'kind'<>p_kind or octet_length(p.payload::text)>32768
      or jsonb_typeof(p.payload->'input') is distinct from 'object' then continue; end if;
    if jsonb_typeof(p.payload->'input'->'questions') is distinct from 'object'
      or p.payload->'input'->>'configurationVersion'<>t.validity_bindings->>'rubricRevisionId' then continue; end if;
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
        or (price->>'maxOutputTokens')::integer<4096
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
    if not public.yuna_usage_user_gate(t.id,reserved,currency_code,price is not null) then continue; end if;
    -- Personal quota reads may cross midnight or the deadline; reserve only in the window whose locks are held.
    n:=clock_timestamp();
    if n>=t.deadline or n>=day_start+interval '1 day' then return null; end if;
    attempt_id:=gen_random_uuid(); reservation_id:=gen_random_uuid(); gen:=t.execution_generation+1;
    lease:=least(t.deadline,n+interval '120 seconds');
    insert into public.usage_reservation
      (id,created_at,installation_id,guild_id,feature,provider,model_route,operation_kind,operation_key,task_id,attempt_number,
       attempt_id,reserved_units,reserved_cost,currency,usage_policy_id,policy_revision,policy_snapshot,pricing_version,
       budget_windows,state,reserved_at,reconcile_after,row_revision,updated_at,purge_after)
    values (reservation_id,n,t.installation_id,t.guild_id,'debates',provider_name,p_model,'task-attempt',t.id::text||':1',t.id,1,
      attempt_id,jsonb_build_object('requests',1,'input_bytes',32768,'output_tokens',4096),
      reserved,currency_code,policy.id,policy.policy_revision,jsonb_build_object('dailyAttemptLimit',cap,'monetaryEstimateAvailable',price is not null,'pricing',price,
        'userId',public.yuna_usage_task_user(t.id)),
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


create function public.yuna_debate_release(p_task uuid,p_attempt uuid,p_generation integer,p_executor text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; a public.task_attempt; n timestamptz; payload jsonb;
begin
  if p_task is null or p_attempt is null or p_generation is null or p_generation<1 or p_executor is null then return null; end if;
  if not public.yuna_debate_gate(p_task) then return null; end if;
  select * into t from public.ai_task where id=p_task;
  select * into a from public.task_attempt where id=p_attempt and task_id=t.id for update;
  n:=clock_timestamp();
  if a.id is null or t.state<>'RUNNING' or t.active_attempt_id<>a.id or t.execution_generation<>p_generation
    or a.generation<>p_generation or a.executor_id<>p_executor or a.state<>'claimed' or n>=a.lease_until or n>=t.deadline then return null; end if;
  update public.task_attempt set state='released',input_released_at=n,row_revision=row_revision+1,updated_at=n where id=a.id;
  select p.payload into payload from public.prepared_input p where p.id=t.prepared_input_id;
  return payload;
end $$;


create function public.yuna_debate_start(p_task uuid,p_attempt uuid,p_generation integer,p_executor text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; a public.task_attempt; n timestamptz;
begin
  if p_task is null or p_attempt is null or p_generation is null or p_generation<1 or p_executor is null then return false; end if;
  if not public.yuna_debate_gate(p_task) then return false; end if;
  select * into t from public.ai_task where id=p_task;
  select * into a from public.task_attempt where id=p_attempt and task_id=t.id for update;
  n:=clock_timestamp();
  if a.id is null or t.state<>'RUNNING' or t.active_attempt_id<>a.id or t.execution_generation<>p_generation
    or a.generation<>p_generation or a.executor_id<>p_executor or a.state<>'released' or n>=a.lease_until or n>=t.deadline then return false; end if;
  update public.task_attempt set state='executing',started_at=n,row_revision=row_revision+1,updated_at=n where id=a.id;
  return true;
end $$;


-- Accept only known capability envelopes; owner acceptance revalidates semantic evidence bindings separately.
create function public.yuna_debate_finish(p_task uuid,p_attempt uuid,p_generation integer,p_executor text,p_result jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare t public.ai_task; a public.task_attempt; n timestamptz; eligible boolean; live boolean;
  result_outcome text; reason text; payload jsonb; usage jsonb; provider_ref text; value text; reported_cost numeric;
  u public.usage_reservation; prior_cost numeric; cost_already_reported boolean:=false;
begin
  if p_task is null or p_attempt is null or p_generation is null or p_generation<1 or p_executor is null then return false; end if;
  if p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>65536 then raise exception 'Invalid debate outcome' using errcode='22023'; end if;
  result_outcome:=p_result->>'outcome'; reason:=p_result->>'reason'; payload:=p_result->'payload'; usage:=p_result->'usage';
  provider_ref:=coalesce(p_result->>'providerRequestId',payload->>'providerRequestId');
  if result_outcome is null or result_outcome not in ('success','failure','uncertain') or reason is null or reason !~ '^[a-z0-9_.-]{1,120}$'
    or (provider_ref is not null and length(provider_ref) not between 1 and 512) then raise exception 'Invalid debate outcome' using errcode='22023'; end if;
  eligible:=public.yuna_debate_gate(p_task);
  select * into t from public.ai_task where id=p_task;
  select * into a from public.task_attempt where id=p_attempt and task_id=p_task for update;
  if t.id is null or t.owner<>'debates' or t.kind not in ('debates.assess') or t.schema_version<>1 or a.id is null
    or a.executor_id<>p_executor or a.generation<>p_generation then return false; end if;
  if usage is not null then
    if jsonb_typeof(usage)<>'object' then raise exception 'Invalid debate usage' using errcode='22023'; end if;
    foreach value in array array['inputTokens','outputTokens','totalTokens'] loop
      if jsonb_typeof(usage->value) is distinct from 'number' or not coalesce(usage->>value ~ '^(0|[1-9][0-9]{0,9})$',false)
        or (usage->>value)::numeric>2147483647 then raise exception 'Invalid debate usage' using errcode='22023'; end if;
    end loop;
    if (usage->>'totalTokens')::bigint<>(usage->>'inputTokens')::bigint+(usage->>'outputTokens')::bigint then raise exception 'Inconsistent debate usage' using errcode='22023'; end if;
    if usage ? 'costUsd' then
      if t.kind<>'debates.assess' or jsonb_typeof(usage->'costUsd') is distinct from 'string'
        or not coalesce(usage->>'costUsd' ~ '^(0|[1-9][0-9]{0,19})([.][0-9]{1,18})?$',false) then raise exception 'Invalid reported debate cost' using errcode='22023'; end if;
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
      or payload->'sourceReferences' is distinct from (select jsonb_build_array('transcript:'||id::text||':'||content_hash)
        from public.transcript_snapshot where id=(t.validity_bindings->>'transcriptSnapshotId')::uuid) then
      raise exception 'Invalid debate capability result' using errcode='22023'; end if;
    if payload->>'outcome' not in ('assessed','uncertain') or payload->>'outcome' is null
      or payload->>'configurationVersion' is distinct from t.validity_bindings->>'rubricRevisionId'
      or jsonb_typeof(payload->'answers') is distinct from 'object' or reported_cost is null
      or payload->'costUsd' is distinct from usage->'costUsd' then raise exception 'Invalid Debate assessment' using errcode='22023'; end if;
  else payload:=null; end if;
  if usage is not null and a.input_released_at is null then raise exception 'Usage requires released input' using errcode='22023'; end if;
  if reported_cost is not null then
    select * into u from public.usage_reservation where id=a.reservation_id for update;
    if u.provider<>'openrouter' or u.currency<>'USD' then raise exception 'Reported cost currency does not match reservation' using errcode='22023'; end if;
    cost_already_reported:=u.resolution_reason='provider_reported_usd';
    if cost_already_reported then
      select actual_cost into prior_cost from public.usage_entry where reservation_id=u.id;
      if prior_cost is distinct from reported_cost then raise exception 'Conflicting reported debate cost' using errcode='22023'; end if;
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
create function public.yuna_debate_recover(p_limit integer) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare candidate uuid; t public.ai_task; a public.task_attempt; eligible boolean; n timestamptz; recovered integer:=0; terminal_outcome text;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid recovery batch' using errcode='22023'; end if;
  for candidate in select id from public.ai_task where state<>'TERMINAL' and kind in ('debates.assess') and owner='debates' and schema_version=1
    order by deadline,created_at,id limit p_limit loop
    eligible:=public.yuna_debate_gate(candidate);
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

revoke all on function public.yuna_debate_gate(uuid) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_debate_claim(text,text) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_debate_release(uuid,uuid,integer,text) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_debate_start(uuid,uuid,integer,text) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_debate_finish(uuid,uuid,integer,text,jsonb) from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_debate_recover(integer) from public,yuna_bot,yuna_worker;
grant execute on function public.yuna_debate_claim(text,text) to yuna_worker;
grant execute on function public.yuna_debate_release(uuid,uuid,integer,text) to yuna_worker;
grant execute on function public.yuna_debate_start(uuid,uuid,integer,text) to yuna_worker;
grant execute on function public.yuna_debate_finish(uuid,uuid,integer,text,jsonb) to yuna_worker;
grant execute on function public.yuna_debate_recover(integer) to yuna_bot;
