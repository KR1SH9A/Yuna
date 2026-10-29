-- Bind AI-planned chores to the exact accepted conversation and measured result.
alter table channel_chore add column planning_request_id uuid, add column planning_result_id uuid;
alter table channel_chore add constraint channel_chore_planning_pair check ((planning_request_id is null) = (planning_result_id is null));
alter table channel_chore add foreign key (installation_id,guild_id,planning_request_id) references conversation_request(installation_id,guild_id,id);
alter table channel_chore add foreign key (installation_id,guild_id,planning_result_id) references task_result(installation_id,guild_id,id);
create index channel_chore_planning_result on channel_chore(planning_result_id) where planning_result_id is not null;
