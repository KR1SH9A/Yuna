-- Administration owns one explicit channel operation per original admin request.
-- SQL-owned like user_usage_limit: only the bot receives CRUD; workers cannot act on it.
create table channel_chore (
  id uuid primary key,
  installation_id uuid not null,
  guild_id text not null,
  actor_id text not null,
  source_channel_id text not null,
  source_message_id text not null,
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  source_event_id uuid not null,
  source_revision integer not null check (source_revision > 0),
  safety_revision integer not null check (safety_revision >= 0),
  operation jsonb,
  operation_hash text not null check (operation_hash ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('READY','DISPATCHED','CONFIRMED','FAILED','UNKNOWN','CANCELED')),
  reason text,
  result_channel_id text,
  created_at timestamptz not null,
  deadline timestamptz not null,
  dispatched_at timestamptz,
  replied_at timestamptz,
  purge_after timestamptz not null,
  metadata_purge_after timestamptz not null,
  payload_purged_at timestamptz,
  unique (installation_id, source_message_id),
  foreign key (installation_id,guild_id) references guild_installation(id,guild_id),
  foreign key (installation_id,guild_id,source_event_id) references intake_event(installation_id,guild_id,id),
  check ((operation is null) = (payload_purged_at is not null)),
  check (deadline > created_at and purge_after >= deadline and metadata_purge_after >= purge_after),
  check (state not in ('DISPATCHED','CONFIRMED','UNKNOWN') or dispatched_at is not null),
  check (state <> 'CONFIRMED' or result_channel_id is not null)
);
create index channel_chore_due on channel_chore(installation_id,state,created_at);
revoke all on channel_chore from public,yuna_bot,yuna_worker;
