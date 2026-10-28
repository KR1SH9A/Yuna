-- Explicit private memory: no embeddings, provider tasks or public copies are enabled by these tables.
-- Composite keys preserve installation, guild and subject identity even when callers use raw SQL.
create table public.memory_scope (
  id uuid primary key, created_at timestamptz not null, installation_id uuid not null, guild_id text not null,
  user_id text not null, purpose_consents jsonb not null, allowed_audiences jsonb not null,
  retention_configuration jsonb not null, privacy_revision integer not null, row_revision integer not null, updated_at timestamptz not null,
  unique(installation_id,guild_id,id), unique(installation_id,guild_id,user_id), unique(installation_id,guild_id,id,user_id),
  check(privacy_revision>=0 and row_revision>=1),
  check(user_id ~ '^[1-9][0-9]{0,19}$' and user_id::numeric<=18446744073709551615),
  foreign key(installation_id,guild_id) references guild_installation(id,guild_id) deferrable initially deferred
);

create table public.memory_fact (
  id uuid primary key, created_at timestamptz not null, installation_id uuid not null, guild_id text not null,
  scope_id uuid not null, subject_user_id text not null, purpose text not null, consent_revision integer not null,
  fact_text text not null, content_hash text not null, source_provenance jsonb not null, audience jsonb not null,
  accepted_task_result_id uuid null, acceptance_operation_key text not null, proposal_item_key text not null,
  replaces_fact_id uuid null, accepted_at timestamptz not null, expires_at timestamptz not null,
  unique(installation_id,guild_id,id), unique(installation_id,guild_id,acceptance_operation_key,proposal_item_key),
  check(expires_at>accepted_at and consent_revision>=0),
  check(subject_user_id ~ '^[1-9][0-9]{0,19}$' and subject_user_id::numeric<=18446744073709551615),
  check(length(fact_text) between 1 and 500 and content_hash ~ '^[a-f0-9]{64}$'),
  check(accepted_task_result_id is null and replaces_fact_id is null),
  check(purpose='personal_reference' and audience='{"kind":"subject"}'::jsonb),
  foreign key(installation_id,guild_id) references guild_installation(id,guild_id) deferrable initially deferred,
  foreign key(installation_id,guild_id,scope_id,subject_user_id) references memory_scope(installation_id,guild_id,id,user_id) deferrable initially deferred
);
create index memory_fact_scope_expiry on public.memory_fact(installation_id,guild_id,scope_id,expires_at);

create table public.memory_deletion_request (
  id uuid primary key, created_at timestamptz not null, installation_id uuid not null, guild_id text not null,
  scope_id uuid not null, deletion_generation integer not null, selection jsonb not null, required_owners jsonb not null,
  owner_progress jsonb not null, state text not null, requested_at timestamptz not null, completed_at timestamptz null,
  next_attempt_at timestamptz null, last_error_code text null, row_revision integer not null, updated_at timestamptz not null,
  purge_after timestamptz not null,
  unique(installation_id,guild_id,id), unique(installation_id,guild_id,scope_id,deletion_generation),
  check(state in ('pending','complete') and (state='complete')=(completed_at is not null)),
  check(row_revision>=1 and deletion_generation>=0),
  foreign key(installation_id,guild_id) references guild_installation(id,guild_id) deferrable initially deferred,
  foreign key(installation_id,guild_id,scope_id) references memory_scope(installation_id,guild_id,id) deferrable initially deferred
);
create index memory_deletion_pending on public.memory_deletion_request(state,next_attempt_at);
-- The migration runner grants the bot access and verifies the worker has no table/column privileges.
revoke all on public.memory_scope,public.memory_fact,public.memory_deletion_request from public,yuna_bot,yuna_worker;
