-- Wake-ups are hints only: durable task/result queries remain authoritative.
-- PostgreSQL emits NOTIFY only after commit, discards it on rollback and may coalesce
-- repeated empty notifications. No message content, identifiers or claim authority leaves SQL.
-- These triggers read no tables and need no SECURITY DEFINER or runtime EXECUTE grants.
create function public.yuna_notify_tasks_ready() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  perform pg_catalog.pg_notify('yuna_tasks_ready', '');
  return null;
end $$;

create function public.yuna_notify_results_ready() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  perform pg_catalog.pg_notify('yuna_results_ready', '');
  return null;
end $$;

create trigger ai_task_notify_ready after insert on public.ai_task
for each statement execute function public.yuna_notify_tasks_ready();

create trigger task_result_notify_ready after insert on public.task_result
for each statement execute function public.yuna_notify_results_ready();

revoke all on function public.yuna_notify_tasks_ready() from public,yuna_bot,yuna_worker;
revoke all on function public.yuna_notify_results_ready() from public,yuna_bot,yuna_worker;
