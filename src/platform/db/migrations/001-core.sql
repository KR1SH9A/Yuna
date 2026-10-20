create table "action_attempt" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "action_id" uuid not null, "attempt_number" int not null, "dispatch_generation" int not null, "executor_id" text not null, "lease_until" timestamptz null, "claimed_at" timestamptz not null, "sent_at" timestamptz null, "finished_at" timestamptz null, "endpoint" text not null, "destination" jsonb not null, "request_fingerprint" text not null, "request_nonce" text null, "http_status" int null, "discord_error_code" text null, "response_class" text null, "discord_message_id" text null, "discord_audit_entry_id" text null, "provider_request_reference" text null, "retry_after_at" timestamptz null, "reconciliation_evidence" jsonb not null, "row_revision" int not null, primary key ("id"));
alter table "action_attempt" add constraint "action_attempt_installation_id_action_id_attempt_number_unique" unique ("installation_id", "action_id", "attempt_number");
alter table "action_attempt" add constraint "action_attempt_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "action_attempt" add constraint "action_attempt_check_4" check (request_nonce IS NULL OR (endpoint = 'create_message' AND length(request_nonce) BETWEEN 1 AND 25));
alter table "action_attempt" add constraint "action_attempt_check_3" check ((finished_at IS NULL) = (response_class IS NULL));
alter table "action_attempt" add constraint "action_attempt_check_2" check (http_status IS NULL OR http_status BETWEEN 100 AND 599);
alter table "action_attempt" add constraint "action_attempt_check_1" check (attempt_number > 0 AND dispatch_generation > 0 AND row_revision > 0);

create table "ai_task" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "owner" text not null, "operation_key" text not null, "kind" text not null, "schema_version" int not null, "workflow_id" uuid null, "stage" text null, "expected_variant" text null, "prepared_input_id" uuid not null, "input_hash" text not null, "source_use" text not null, "validity_bindings" jsonb not null, "provider_configuration_version" text not null, "model_version" text not null, "prompt_version" text not null, "deadline" timestamptz null, "state" text not null, "active_attempt_id" uuid null, "attempt_count" int not null, "max_attempts" int not null, "next_attempt_at" timestamptz null, "park_reason" text null, "execution_generation" int not null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
create index "ai_task_state_next_attempt_at_index" on "ai_task" ("state", "next_attempt_at");
alter table "ai_task" add constraint "ai_task_prepared_input_id_unique" unique ("prepared_input_id");
alter table "ai_task" add constraint "ai_task_installation_id_owner_operation_key_kind__e0005_unique" unique ("installation_id", "owner", "operation_key", "kind", "schema_version");
alter table "ai_task" add constraint "ai_task_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "ai_task" add constraint "ai_task_check_3" check ((state = 'RUNNING') = (active_attempt_id is not null));
alter table "ai_task" add constraint "ai_task_check_2" check (attempt_count >= 0 and attempt_count <= max_attempts and max_attempts > 0 and execution_generation >= 0 and schema_version > 0);
alter table "ai_task" add constraint "ai_task_check_1" check (state in ('READY', 'RUNNING', 'RETRY_WAIT', 'PARKED', 'TERMINAL'));

create table "artifact_record" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "owner" text not null, "owner_record_ref" uuid not null, "retention_scope" text not null, "storage_key" text not null, "state" text not null, "source_attachment_id" text null, "source_message_id" text null, "source_channel_id" text null, "original_metadata" jsonb null, "access_binding" jsonb not null, "upload_deadline" timestamptz not null, "expires_at" timestamptz not null, "verified_hash" text null, "media_type" text null, "byte_size" bigint null, "ready_at" timestamptz null, "deletion_started_at" timestamptz null, "deleted_at" timestamptz null, "next_attempt_at" timestamptz null, "failure_code" text null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
create index "artifact_record_state_expires_at_index" on "artifact_record" ("state", "expires_at");
create index "artifact_record_state_next_attempt_at_index" on "artifact_record" ("state", "next_attempt_at");
alter table "artifact_record" add constraint "artifact_record_storage_key_unique" unique ("storage_key");
alter table "artifact_record" add constraint "artifact_record_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "artifact_record" add constraint "artifact_record_check_2" check (state <> 'READY' or (verified_hash is not null and byte_size is not null and ready_at is not null));
alter table "artifact_record" add constraint "artifact_record_check_1" check (expires_at >= upload_deadline and (byte_size is null or byte_size >= 0));

create table "audit_entry" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "schema_version" int not null, "occurred_at" timestamptz not null, "origin" jsonb not null, "operation" text not null, "references" jsonb not null, "outcome" text not null, "correlation_id" text not null, "idempotency_key" text not null, "purge_after" timestamptz not null, primary key ("id"));
create index "audit_entry_purge_after_index" on "audit_entry" ("purge_after");
create index "audit_entry_installation_id_correlation_id_occurred_at_index" on "audit_entry" ("installation_id", "correlation_id", "occurred_at");
alter table "audit_entry" add constraint "audit_entry_installation_id_idempotency_key_unique" unique ("installation_id", "idempotency_key");
alter table "audit_entry" add constraint "audit_entry_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");

create table "capability_grant" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "grantee" jsonb not null, "capability" text not null, "scope" jsonb not null, "grantor" jsonb not null, "source_request_id" text not null, "source_operation_key" text not null, "granted_at" timestamptz not null, "expires_at" timestamptz null, "revoked_at" timestamptz null, "revocation_reason" text null, "authority_revision" int not null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
alter table "capability_grant" add constraint "capability_grant_installation_id_guild_id_source__e93f6_unique" unique ("installation_id", "guild_id", "source_request_id", "source_operation_key");
alter table "capability_grant" add constraint "capability_grant_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "capability_grant" add constraint "capability_grant_check_3" check ("row_revision" >= 1);
alter table "capability_grant" add constraint "capability_grant_check_2" check ("revoked_at" is null or "revoked_at" >= "granted_at");
alter table "capability_grant" add constraint "capability_grant_check_1" check ("expires_at" is null or "expires_at" > "granted_at");

create table "channel_reply_settings" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "channel_id" text not null, "mode" text not null, "approved_knowledge_scope" jsonb not null, "limits" jsonb not null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
alter table "channel_reply_settings" add constraint "channel_reply_settings_installation_id_channel_id_unique" unique ("installation_id", "channel_id");
alter table "channel_reply_settings" add constraint "channel_reply_settings_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "channel_reply_settings" add constraint "channel_reply_settings_check_1" check (mode IN ('silent', 'direct', 'proactive') AND row_revision > 0);

create table "conversation_request" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "request_key" text not null, "source_kind" text not null, "source_channel_id" text not null, "source_message_id" text null, "interaction_id" text null, "interaction_continuation" jsonb null, "source_version" int not null, "stage" text not null, "expected_task_id" uuid null, "accepted_result_reference" uuid null, "settings_revision" int not null, "context_bindings" jsonb null, "audience_binding" jsonb not null, "deadline" timestamptz not null, "canceled_at" timestamptz null, "cancellation_reason" text null, "cancellation_generation" int not null, "row_revision" int not null, "updated_at" timestamptz not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
alter table "conversation_request" add constraint "conversation_request_installation_id_request_key_unique" unique ("installation_id", "request_key");
alter table "conversation_request" add constraint "conversation_request_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "conversation_request" add constraint "conversation_request_check_5" check ((payload_purged_at IS NULL AND purge_reason IS NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND context_bindings IS NULL AND interaction_continuation IS NULL));
alter table "conversation_request" add constraint "conversation_request_check_4" check (stage <> 'accepted' OR accepted_result_reference IS NOT NULL);
alter table "conversation_request" add constraint "conversation_request_check_3" check ((canceled_at IS NULL) = (cancellation_reason IS NULL));
alter table "conversation_request" add constraint "conversation_request_check_2" check (stage IN ('created', 'routing', 'routed', 'generating', 'accepted', 'declined', 'canceled'));
alter table "conversation_request" add constraint "conversation_request_check_1" check ((source_kind = 'message' AND source_message_id IS NOT NULL AND interaction_id IS NULL AND interaction_continuation IS NULL) OR (source_kind = 'interaction' AND source_message_id IS NULL AND interaction_id IS NOT NULL));

create table "evidence_revision" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "case_id" uuid not null, "capture_revision" int not null, "original_event_id" uuid not null, "source_channel_id" text not null, "source_message_id" text not null, "original_author_user_id" text null, "author_kind" text not null, "webhook_id" text null, "message_type" int not null, "original_created_at" timestamptz null, "captured_at" timestamptz not null, "original_content" text null, "original_content_hash" text null, "original_attachment_descriptors" jsonb null, "artifact_references" jsonb null, "capture_coverage" jsonb not null, "missing_reasons" jsonb not null, "supersedes_evidence_id" uuid null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
alter table "evidence_revision" add constraint "evidence_revision_installation_id_case_id_capture_cdab0_unique" unique ("installation_id", "case_id", "capture_revision");
alter table "evidence_revision" add constraint "evidence_revision_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "evidence_revision" add constraint "evidence_revision_check_4" check (purge_after > captured_at);
alter table "evidence_revision" add constraint "evidence_revision_check_3" check ((payload_purged_at IS NULL AND purge_reason IS NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND original_content IS NULL AND original_attachment_descriptors IS NULL AND artifact_references IS NULL));
alter table "evidence_revision" add constraint "evidence_revision_check_2" check (author_kind IN ('user', 'bot', 'webhook', 'system', 'unknown'));
alter table "evidence_revision" add constraint "evidence_revision_check_1" check (capture_revision >= 0);

create table "guild_installation" ("id" uuid not null, "created_at" timestamptz not null, "guild_id" text not null, "generation" int not null, "state" text not null, "discord_availability" text not null, "availability_observed_at" timestamptz null, "feature_admission" jsonb not null, "registered_at" timestamptz not null, "suspended_at" timestamptz null, "removal_started_at" timestamptz null, "removed_at" timestamptz null, "lifecycle_reason" text null, "required_cleanup_owners" jsonb not null, "cleanup_progress" jsonb not null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
create unique index "guild_installation_current_guild_unique" on "guild_installation" ("guild_id") where state in ('active', 'suspended');
alter table "guild_installation" add constraint "guild_installation_guild_id_generation_unique" unique ("guild_id", "generation");
alter table "guild_installation" add constraint "guild_installation_id_guild_id_unique" unique ("id", "guild_id");
alter table "guild_installation" add constraint "guild_installation_check_5" check ("row_revision" >= 1);
alter table "guild_installation" add constraint "guild_installation_check_4" check ("state" not in ('removing', 'removed') or "removal_started_at" is not null);
alter table "guild_installation" add constraint "guild_installation_check_3" check (("state" = 'removed') = ("removed_at" is not null));
alter table "guild_installation" add constraint "guild_installation_check_2" check ("state" in ('active', 'suspended', 'removing', 'removed'));
alter table "guild_installation" add constraint "guild_installation_check_1" check ("generation" >= 0);

create table "guild_safety_state" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "paused" boolean not null, "safety_revision" int not null, "reason_code" text null, "changed_by" jsonb not null, "changed_at" timestamptz not null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
alter table "guild_safety_state" add constraint "guild_safety_state_installation_id_guild_id_unique" unique ("installation_id", "guild_id");
alter table "guild_safety_state" add constraint "guild_safety_state_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "guild_safety_state" add constraint "guild_safety_state_check_2" check ("row_revision" >= 1);
alter table "guild_safety_state" add constraint "guild_safety_state_check_1" check ("safety_revision" >= 0);

create table "intake_delivery" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "event_id" uuid not null, "owner" text not null, "order_key" text not null, "state" text not null, "claim_generation" int not null, "lease_owner" text null, "lease_until" timestamptz null, "attempt_count" int not null, "next_attempt_at" timestamptz null, "processing_deadline" timestamptz null, "outcome" text null, "owner_record_ref" uuid null, "completed_at" timestamptz null, "blocked_reason" text null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
create index "intake_delivery_state_next_attempt_at_index" on "intake_delivery" ("state", "next_attempt_at");
alter table "intake_delivery" add constraint "intake_delivery_installation_id_event_id_owner_unique" unique ("installation_id", "event_id", "owner");
alter table "intake_delivery" add constraint "intake_delivery_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "intake_delivery" add constraint "intake_delivery_check_3" check (claim_generation >= 0 and attempt_count >= 0 and row_revision >= 0);
alter table "intake_delivery" add constraint "intake_delivery_check_2" check ((state = 'RUNNING') = (lease_owner is not null and lease_until is not null));
alter table "intake_delivery" add constraint "intake_delivery_check_1" check ((state = 'DONE') = (completed_at is not null and outcome is not null));

create table "intake_event" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "event_kind" text not null, "source_event_key" text not null, "source_key" text null, "target_source_key" text null, "interaction_id" text null, "request_actor_id" text null, "gateway_session_id" text null, "shard_id" int null, "gateway_sequence" int null, "ingress_sequence" bigint not null, "observed_at" timestamptz not null, "message_created_at" timestamptz null, "message_edited_at" timestamptz null, "author_kind" text not null, "author_user_id" text null, "webhook_id" text null, "message_type" int null, "snapshot" jsonb null, "content_access" text not null, "coverage" jsonb not null, "content_hash" text null, "original_attachments" jsonb not null, "is_current_source_marker" boolean not null, "source_validity" text not null, "source_version" int not null, "deleted_observed_at" timestamptz null, "purge_after" timestamptz not null, "metadata_purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
create unique index intake_current_source_unique on intake_event (installation_id, source_key) where is_current_source_marker = true;
create index "intake_event_purge_after_index" on "intake_event" ("purge_after");
alter table "intake_event" add constraint "intake_event_installation_id_source_event_key_unique" unique ("installation_id", "source_event_key");
alter table "intake_event" add constraint "intake_event_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "intake_event" add constraint "intake_event_check_3" check (metadata_purge_after >= purge_after);
alter table "intake_event" add constraint "intake_event_check_2" check (ingress_sequence >= 0 and source_version >= 0);
alter table "intake_event" add constraint "intake_event_check_1" check (not is_current_source_marker or (source_key is not null and event_kind in ('message_create', 'message_update', 'message_delete')));

create table "knowledge_entry" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "content" text null, "content_hash" text not null, "provenance" jsonb null, "approval_actor_id" text not null, "approved_at" timestamptz not null, "visibility" jsonb not null, "row_revision" int not null, "retired_at" timestamptz null, "replacement_entry_id" uuid null, "updated_at" timestamptz not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
alter table "knowledge_entry" add constraint "knowledge_entry_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "knowledge_entry" add constraint "knowledge_entry_check_3" check (purge_after > approved_at);
alter table "knowledge_entry" add constraint "knowledge_entry_check_2" check ((payload_purged_at IS NULL AND purge_reason IS NULL AND content IS NOT NULL AND provenance IS NOT NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND content IS NULL AND provenance IS NULL AND retired_at IS NOT NULL));
alter table "knowledge_entry" add constraint "knowledge_entry_check_1" check (replacement_entry_id IS NULL OR retired_at IS NOT NULL);

create table "moderation_action" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "kind" text not null, "target_user_id" text not null, "origin" text not null, "source_request_id" text null, "actor_user_id" text null, "grant_binding" jsonb null, "admin_unban_request" jsonb null, "case_id" uuid null, "evidence_revision_id" uuid null, "policy_revision_id" uuid null, "deduplication_key" text not null, "operation_payload" jsonb null, "payload_hash" text not null, "audit_correlation" text not null, "safety_revision" int not null, "state" text not null, "execution_generation" int not null, "active_attempt_id" uuid null, "next_attempt_at" timestamptz null, "outcome_summary" jsonb null, "row_revision" int not null, "updated_at" timestamptz not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
create index "moderation_action_state_next_attempt_at_index" on "moderation_action" ("state", "next_attempt_at");
alter table "moderation_action" add constraint "moderation_action_installation_id_deduplication_key_unique" unique ("installation_id", "deduplication_key");
alter table "moderation_action" add constraint "moderation_action_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "moderation_action" add constraint "moderation_action_check_9" check (execution_generation >= 0 AND row_revision > 0);
alter table "moderation_action" add constraint "moderation_action_check_8" check (state NOT IN ('DISPATCHED', 'UNKNOWN', 'CONFIRMED') OR active_attempt_id IS NOT NULL);
alter table "moderation_action" add constraint "moderation_action_check_7" check (state <> 'READY' OR operation_payload IS NOT NULL);
alter table "moderation_action" add constraint "moderation_action_check_6" check ((payload_purged_at IS NULL AND purge_reason IS NULL AND operation_payload IS NOT NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND operation_payload IS NULL));
alter table "moderation_action" add constraint "moderation_action_check_5" check (grant_binding IS NULL OR (grant_binding->>'operationHash' = payload_hash) IS TRUE);
alter table "moderation_action" add constraint "moderation_action_check_4" check (operation_payload IS NULL OR (operation_payload->>'kind' = kind AND operation_payload->>'schemaVersion' = '1') IS TRUE);
alter table "moderation_action" add constraint "moderation_action_check_3" check (kind <> 'unban' OR (origin = 'staff' AND admin_unban_request IS NOT NULL AND admin_unban_request->>'source' = 'yuna' AND admin_unban_request->>'authorizationKind' = 'discord_administrator' AND admin_unban_request->>'requestId' = source_request_id AND admin_unban_request->>'actorUserId' = actor_user_id AND admin_unban_request->>'targetUserId' = target_user_id) IS TRUE);
alter table "moderation_action" add constraint "moderation_action_check_2" check ((origin = 'policy' AND case_id IS NOT NULL AND evidence_revision_id IS NOT NULL AND policy_revision_id IS NOT NULL AND source_request_id IS NULL AND actor_user_id IS NULL AND grant_binding IS NULL) OR (origin = 'staff' AND source_request_id IS NOT NULL AND actor_user_id IS NOT NULL AND grant_binding IS NOT NULL AND evidence_revision_id IS NULL AND policy_revision_id IS NULL));
alter table "moderation_action" add constraint "moderation_action_check_1" check (kind IN ('ban', 'unban', 'warning', 'kick') AND state IN ('READY', 'DISPATCHED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'CANCELED'));

create table "moderation_case" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "source_channel_id" text not null, "source_message_id" text not null, "subject_user_id" text null, "original_event_id" uuid null, "workflow_phase" text not null, "disposition" text null, "current_evidence_revision_id" uuid null, "policy_revision_id" uuid not null, "expected_task_id" uuid null, "generation" int not null, "row_revision" int not null, "updated_at" timestamptz not null, "capture_reason" text null, primary key ("id"));
alter table "moderation_case" add constraint "moderation_case_installation_id_guild_id_source_c_d7c55_unique" unique ("installation_id", "guild_id", "source_channel_id", "source_message_id");
alter table "moderation_case" add constraint "moderation_case_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "moderation_case" add constraint "moderation_case_check_3" check (workflow_phase NOT IN ('observing', 'assessing') OR (expected_task_id IS NOT NULL AND current_evidence_revision_id IS NOT NULL));
alter table "moderation_case" add constraint "moderation_case_check_2" check (generation >= 0 AND row_revision > 0);
alter table "moderation_case" add constraint "moderation_case_check_1" check (workflow_phase IN ('awaiting_original', 'captured', 'observing', 'assessing', 'complete'));

create table "moderation_finding" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "case_id" uuid not null, "evidence_revision_id" uuid not null, "policy_revision_id" uuid not null, "rule_id" text not null, "rule_version" text not null, "observation_task_result_id" uuid null, "assessment_task_result_id" uuid not null, "supported_facts" jsonb null, "evidence_references" jsonb null, "exclusions" jsonb null, "coverage" jsonb null, "disposition" text not null, "accepted_at" timestamptz not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
alter table "moderation_finding" add constraint "moderation_finding_installation_id_assessment_tas_bc382_unique" unique ("installation_id", "assessment_task_result_id", "rule_id");
alter table "moderation_finding" add constraint "moderation_finding_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "moderation_finding" add constraint "moderation_finding_check_3" check (purge_after > accepted_at);
alter table "moderation_finding" add constraint "moderation_finding_check_2" check ((payload_purged_at IS NULL AND purge_reason IS NULL AND supported_facts IS NOT NULL AND evidence_references IS NOT NULL AND coverage IS NOT NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND supported_facts IS NULL AND evidence_references IS NULL AND coverage IS NULL AND exclusions IS NULL));
alter table "moderation_finding" add constraint "moderation_finding_check_1" check (disposition IN ('violation', 'suspicion', 'clear', 'incomplete'));

create table "moderation_action_finding" ("action_id" uuid not null, "finding_id" uuid not null, primary key ("action_id", "finding_id"));

create table "moderation_policy_revision" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "revision_number" int not null, "rules" jsonb not null, "required_evidence" jsonb not null, "exclusions" jsonb not null, "evaluation_configuration" jsonb not null, "action_mapping" jsonb not null, "publisher_user_id" text not null, "publisher_request_id" text not null, "published_at" timestamptz not null, primary key ("id"));
alter table "moderation_policy_revision" add constraint "moderation_policy_revision_installation_id_revisi_af90f_unique" unique ("installation_id", "revision_number");
alter table "moderation_policy_revision" add constraint "moderation_policy_revision_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "moderation_policy_revision" add constraint "moderation_policy_revision_check_1" check (revision_number >= 0);

create table "outbox_entry" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid null, "guild_id" text null, "topic" text not null, "schema_version" int not null, "record_id" uuid not null, "deduplication_key" text not null, "state" text not null, "claim_generation" int not null, "claimed_by" text null, "lease_until" timestamptz null, "attempt_count" int not null, "next_attempt_at" timestamptz not null, "published_at" timestamptz null, "blocked_reason" text null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
create index "outbox_entry_state_lease_until_index" on "outbox_entry" ("state", "lease_until");
create index "outbox_entry_state_next_attempt_at_index" on "outbox_entry" ("state", "next_attempt_at");
alter table "outbox_entry" add constraint "outbox_entry_deduplication_key_unique" unique ("deduplication_key");
alter table "outbox_entry" add constraint "outbox_entry_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "outbox_entry" add constraint "outbox_entry_check_5" check (state <> 'published' or published_at is not null);
alter table "outbox_entry" add constraint "outbox_entry_check_4" check ((state = 'claimed') = (lease_until is not null and claimed_by is not null));
alter table "outbox_entry" add constraint "outbox_entry_check_3" check (state in ('pending', 'claimed', 'published', 'parked') and claim_generation >= 0 and attempt_count >= 0);
alter table "outbox_entry" add constraint "outbox_entry_check_2" check (topic in ('task.execute', 'task.complete', 'work.invalidate') and schema_version = 1);
alter table "outbox_entry" add constraint "outbox_entry_check_1" check ((installation_id is null) = (guild_id is null));

create table "prepared_input" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "task_id" uuid not null, "schema_version" int not null, "payload" jsonb null, "content_hash" text not null, "artifact_handles" jsonb not null, "provenance" jsonb null, "purpose" text not null, "audience" jsonb null, "source_use" text not null, "validity_bindings" jsonb not null, "source_event_id" uuid null, "privacy_scope_id" uuid null, "policy_revision_id" uuid null, "eligible" boolean not null, "invalidated_at" timestamptz null, "invalidation_reason" text null, "expires_at" timestamptz null, "cleanup_state" text not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
create index "prepared_input_cleanup_state_purge_after_index" on "prepared_input" ("cleanup_state", "purge_after");
create index "prepared_input_installation_id_guild_id_eligible_p_2120f_index" on "prepared_input" ("installation_id", "guild_id", "eligible", "policy_revision_id");
create index "prepared_input_installation_id_guild_id_eligible_p_ae086_index" on "prepared_input" ("installation_id", "guild_id", "eligible", "privacy_scope_id");
create index "prepared_input_installation_id_guild_id_eligible_s_6a965_index" on "prepared_input" ("installation_id", "guild_id", "eligible", "source_event_id");
alter table "prepared_input" add constraint "prepared_input_task_id_unique" unique ("task_id");
alter table "prepared_input" add constraint "prepared_input_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "prepared_input" add constraint "prepared_input_check_4" check (cleanup_state <> 'purged' or (payload is null and payload_purged_at is not null and not eligible));
alter table "prepared_input" add constraint "prepared_input_check_3" check (not eligible or (payload is not null and invalidated_at is null));
alter table "prepared_input" add constraint "prepared_input_check_2" check (cleanup_state in ('retained', 'pending', 'purged'));
alter table "prepared_input" add constraint "prepared_input_check_1" check (source_use in ('original_evidence', 'current_source', 'none') and schema_version > 0);

create table "reply_delivery" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "request_id" uuid not null, "accepted_result_reference" uuid not null, "accepted_content" text null, "content_hash" text not null, "supporting_references" jsonb null, "allowed_mentions" jsonb null, "transport" text not null, "channel_id" text null, "reply_message_id" text null, "nonce" text null, "enforce_nonce" boolean null, "application_id" text null, "interaction_id" text null, "token_ciphertext" text null, "token_key_id" text null, "token_expires_at" timestamptz null, "ephemeral" boolean null, "acknowledgment" text null, "acknowledged_at" timestamptz null, "source_version" int not null, "privacy_revision" int not null, "audience_binding" jsonb not null, "deadline" timestamptz not null, "state" text not null, "generation" int not null, "attempt_count" int not null, "max_attempts" int not null, "attempt" jsonb null, "discord_message_id" text null, "next_attempt_at" timestamptz null, "outcome_details" jsonb null, "row_revision" int not null, "updated_at" timestamptz not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, primary key ("id"));
create index "reply_delivery_state_next_attempt_at_index" on "reply_delivery" ("state", "next_attempt_at");
alter table "reply_delivery" add constraint "reply_delivery_installation_id_request_id_unique" unique ("installation_id", "request_id");
alter table "reply_delivery" add constraint "reply_delivery_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "reply_delivery" add constraint "reply_delivery_check_8" check (max_attempts > 0 AND attempt_count >= 0 AND attempt_count <= max_attempts AND generation >= 0 AND row_revision > 0);
alter table "reply_delivery" add constraint "reply_delivery_check_7" check ((payload_purged_at IS NULL AND purge_reason IS NULL AND accepted_content IS NOT NULL) OR (payload_purged_at IS NOT NULL AND purge_reason IS NOT NULL AND accepted_content IS NULL AND supporting_references IS NULL AND allowed_mentions IS NULL));
alter table "reply_delivery" add constraint "reply_delivery_check_6" check (accepted_content IS NULL OR length(accepted_content) BETWEEN 1 AND 2000);
alter table "reply_delivery" add constraint "reply_delivery_check_5" check (state <> 'READY' OR (accepted_content IS NOT NULL AND (transport <> 'interaction_original' OR token_ciphertext IS NOT NULL)));
alter table "reply_delivery" add constraint "reply_delivery_check_4" check (state <> 'DELIVERED' OR discord_message_id IS NOT NULL);
alter table "reply_delivery" add constraint "reply_delivery_check_3" check ((token_ciphertext IS NULL) = (token_key_id IS NULL));
alter table "reply_delivery" add constraint "reply_delivery_check_2" check ((transport = 'channel_message' AND channel_id IS NOT NULL AND nonce IS NOT NULL AND length(nonce) BETWEEN 1 AND 25 AND enforce_nonce IS NOT NULL AND application_id IS NULL AND interaction_id IS NULL AND token_ciphertext IS NULL AND token_key_id IS NULL AND token_expires_at IS NULL AND ephemeral IS NULL AND acknowledgment IS NULL AND acknowledged_at IS NULL) OR (transport = 'interaction_original' AND channel_id IS NULL AND reply_message_id IS NULL AND nonce IS NULL AND enforce_nonce IS NULL AND application_id IS NOT NULL AND interaction_id IS NOT NULL AND token_expires_at IS NOT NULL AND ephemeral IS NOT NULL AND acknowledgment IS NOT NULL AND acknowledgment = 'deferred' AND acknowledged_at IS NOT NULL));
alter table "reply_delivery" add constraint "reply_delivery_check_1" check (state IN ('READY', 'DISPATCHED', 'UNKNOWN', 'DELIVERED', 'FAILED', 'CANCELED', 'EXPIRED'));

create table "target_execution_state" ("guild_id" text not null, "target_user_id" text not null, "generation" int not null, "unresolved_action_id" uuid null, "unresolved_installation_id" uuid null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("guild_id", "target_user_id"));
alter table "target_execution_state" add constraint "target_execution_state_check_2" check (generation >= 0 AND row_revision > 0);
alter table "target_execution_state" add constraint "target_execution_state_check_1" check ((unresolved_action_id IS NULL) = (unresolved_installation_id IS NULL));

create table "task_acceptance" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "task_id" uuid not null, "result_id" uuid not null, "owner" text not null, "operation_key" text not null, "workflow_id" uuid null, "stage" text null, "source_use" text not null, "validity_bindings" jsonb not null, "decision" text not null, "reason" text not null, "acknowledged_at" timestamptz not null, primary key ("id"));
alter table "task_acceptance" add constraint "task_acceptance_result_id_unique" unique ("result_id");
alter table "task_acceptance" add constraint "task_acceptance_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "task_acceptance" add constraint "task_acceptance_check_1" check (decision in ('accepted', 'discarded'));

create table "task_attempt" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "task_id" uuid not null, "attempt_number" int not null, "generation" int not null, "executor_id" text not null, "reservation_id" uuid not null, "lease_until" timestamptz not null, "claimed_at" timestamptz not null, "input_released_at" timestamptz null, "started_at" timestamptz null, "finished_at" timestamptz null, "provider_request_id" text null, "state" text not null, "failure_class" text null, "failure_code" text null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
create index "task_attempt_state_lease_until_index" on "task_attempt" ("state", "lease_until");
alter table "task_attempt" add constraint "task_attempt_reservation_id_unique" unique ("reservation_id");
alter table "task_attempt" add constraint "task_attempt_installation_id_task_id_attempt_number_unique" unique ("installation_id", "task_id", "attempt_number");
alter table "task_attempt" add constraint "task_attempt_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "task_attempt" add constraint "task_attempt_check_3" check (started_at is null or input_released_at is not null);
alter table "task_attempt" add constraint "task_attempt_check_2" check (attempt_number > 0 and generation > 0 and lease_until > claimed_at);
alter table "task_attempt" add constraint "task_attempt_check_1" check (state in ('claimed', 'released', 'executing', 'finished', 'fenced'));

create table "task_result" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "task_id" uuid not null, "attempt_id" uuid null, "attempt_generation" int null, "outcome" text not null, "schema_version" int not null, "payload" jsonb null, "reason" text not null, "usage_reservation_id" uuid null, "execution_started_at" timestamptz null, "completed_at" timestamptz not null, "payload_unavailable" boolean not null, "pending_owner_discard" boolean not null, "purge_after" timestamptz not null, "payload_purged_at" timestamptz null, "purge_reason" text null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
create index "task_result_purge_after_index" on "task_result" ("purge_after");
create index "task_result_pending_owner_discard_created_at_index" on "task_result" ("pending_owner_discard", "created_at");
alter table "task_result" add constraint "task_result_task_id_unique" unique ("task_id");
alter table "task_result" add constraint "task_result_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "task_result" add constraint "task_result_check_6" check (not payload_unavailable or (payload is null and payload_purged_at is not null));
alter table "task_result" add constraint "task_result_check_5" check (outcome <> 'success' or payload is not null or payload_unavailable);
alter table "task_result" add constraint "task_result_check_4" check (attempt_id is not null or outcome in ('canceled', 'expired'));
alter table "task_result" add constraint "task_result_check_3" check (attempt_generation is null or attempt_generation > 0);
alter table "task_result" add constraint "task_result_check_2" check ((attempt_id is null) = (attempt_generation is null));
alter table "task_result" add constraint "task_result_check_1" check (outcome in ('success', 'uncertain', 'failure', 'canceled', 'expired') and schema_version > 0);

create table "usage_entry" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "reservation_id" uuid not null, "operation_kind" text not null, "operation_key" text not null, "attempt_id" uuid null, "provider" text not null, "provider_request_id" text null, "pricing_version" text not null, "currency" text not null, "accounting_state" text not null, "estimated_cost" numeric(38,18) null, "actual_cost" numeric(38,18) null, "reported_units" jsonb null, "evidence" jsonb not null, "first_recorded_at" timestamptz not null, "last_evidence_at" timestamptz not null, "reconcile_after" timestamptz null, "row_revision" int not null, "updated_at" timestamptz not null, "purge_after" timestamptz not null, primary key ("id"));
create index "usage_entry_guild_id_provider_first_recorded_at_index" on "usage_entry" ("guild_id", "provider", "first_recorded_at");
create index "usage_entry_accounting_state_reconcile_after_index" on "usage_entry" ("accounting_state", "reconcile_after");
alter table "usage_entry" add constraint "usage_entry_attempt_id_unique" unique ("attempt_id");
alter table "usage_entry" add constraint "usage_entry_installation_id_guild_id_operation_ki_0639a_unique" unique ("installation_id", "guild_id", "operation_kind", "operation_key");
alter table "usage_entry" add constraint "usage_entry_reservation_id_unique" unique ("reservation_id");
alter table "usage_entry" add constraint "usage_entry_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "usage_entry" add constraint "usage_entry_check_4" check ((accounting_state = 'estimated' and actual_cost is null and reconcile_after is not null) or (accounting_state = 'actual' and actual_cost is not null) or (accounting_state = 'no-spend' and actual_cost is not null and actual_cost = 0));
alter table "usage_entry" add constraint "usage_entry_check_3" check ((estimated_cost is null or estimated_cost >= 0) and (actual_cost is null or actual_cost >= 0));
alter table "usage_entry" add constraint "usage_entry_check_2" check (accounting_state <> 'estimated' or estimated_cost is not null or (reported_units is not null and reported_units <> '{}'::jsonb));
alter table "usage_entry" add constraint "usage_entry_check_1" check (operation_kind in ('task-attempt', 'explicit-operation') and accounting_state in ('estimated', 'actual', 'no-spend'));

create table "usage_policy" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "policy_revision" int not null, "schema_version" int not null, "limits" jsonb not null, "window_rules" jsonb not null, "per_attempt_bounds" jsonb not null, "effective_at" timestamptz not null, "updated_by" jsonb not null, "row_revision" int not null, "updated_at" timestamptz not null, primary key ("id"));
alter table "usage_policy" add constraint "usage_policy_installation_id_guild_id_unique" unique ("installation_id", "guild_id");
alter table "usage_policy" add constraint "usage_policy_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "usage_policy" add constraint "usage_policy_check_2" check ("row_revision" >= 1);
alter table "usage_policy" add constraint "usage_policy_check_1" check ("policy_revision" >= 0);

create table "usage_reservation" ("id" uuid not null, "created_at" timestamptz not null, "installation_id" uuid not null, "guild_id" text not null, "feature" text not null, "provider" text not null, "model_route" text not null, "operation_kind" text not null, "operation_key" text not null, "task_id" uuid null, "attempt_number" int null, "attempt_id" uuid null, "reserved_units" jsonb not null, "reserved_cost" numeric(38,18) not null, "currency" text not null, "usage_policy_id" uuid not null, "policy_revision" int not null, "policy_snapshot" jsonb not null, "pricing_version" text not null, "budget_windows" jsonb not null, "state" text not null, "reserved_at" timestamptz not null, "reconcile_after" timestamptz not null, "released_at" timestamptz null, "settled_at" timestamptz null, "resolution_reason" text null, "resolution_evidence" jsonb null, "row_revision" int not null, "updated_at" timestamptz not null, "purge_after" timestamptz not null, primary key ("id"));
create index "usage_reservation_guild_id_provider_state_index" on "usage_reservation" ("guild_id", "provider", "state");
create index "usage_reservation_state_reconcile_after_index" on "usage_reservation" ("state", "reconcile_after");
alter table "usage_reservation" add constraint "usage_reservation_attempt_id_unique" unique ("attempt_id");
alter table "usage_reservation" add constraint "usage_reservation_installation_id_task_id_attempt_number_unique" unique ("installation_id", "task_id", "attempt_number");
alter table "usage_reservation" add constraint "usage_reservation_installation_id_guild_id_operat_70809_unique" unique ("installation_id", "guild_id", "operation_kind", "operation_key");
alter table "usage_reservation" add constraint "usage_reservation_installation_id_guild_id_id_unique" unique ("installation_id", "guild_id", "id");
alter table "usage_reservation" add constraint "usage_reservation_check_5" check (state <> 'released' or released_at is not null);
alter table "usage_reservation" add constraint "usage_reservation_check_4" check (state <> 'settled' or settled_at is not null);
alter table "usage_reservation" add constraint "usage_reservation_check_3" check (reserved_cost >= 0 and policy_revision >= 0);
alter table "usage_reservation" add constraint "usage_reservation_check_2" check ((operation_kind = 'task-attempt' and task_id is not null and attempt_number is not null and attempt_number > 0) or (operation_kind = 'explicit-operation' and task_id is null and attempt_number is null and attempt_id is null));
alter table "usage_reservation" add constraint "usage_reservation_check_1" check (operation_kind in ('task-attempt', 'explicit-operation') and state in ('reserved', 'liability', 'settled', 'released'));

alter table "moderation_action_finding" add constraint "moderation_action_finding_action_id_foreign" foreign key ("action_id") references "moderation_action" ("id") on update cascade on delete cascade;
alter table "moderation_action_finding" add constraint "moderation_action_finding_finding_id_foreign" foreign key ("finding_id") references "moderation_finding" ("id") on update cascade on delete cascade;

alter table "usage_reservation" add constraint "usage_reservation_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "usage_reservation" add constraint "usage_reservation_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "usage_policy" add constraint "usage_policy_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "usage_policy" add constraint "usage_policy_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "usage_entry" add constraint "usage_entry_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "usage_entry" add constraint "usage_entry_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "task_result" add constraint "task_result_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "task_result" add constraint "task_result_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "task_attempt" add constraint "task_attempt_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "task_attempt" add constraint "task_attempt_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "task_acceptance" add constraint "task_acceptance_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "task_acceptance" add constraint "task_acceptance_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "target_execution_state" add constraint "target_execution_state_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "target_execution_state" add constraint "target_execution_state_target_user_id_snowflake" check ("target_user_id" is null or ("target_user_id" ~ '^[1-9][0-9]{0,19}$' and "target_user_id"::numeric <= 18446744073709551615));
alter table "reply_delivery" add constraint "reply_delivery_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "reply_delivery" add constraint "reply_delivery_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "prepared_input" add constraint "prepared_input_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "prepared_input" add constraint "prepared_input_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "outbox_entry" add constraint "outbox_entry_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "outbox_entry" add constraint "outbox_entry_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "moderation_policy_revision" add constraint "moderation_policy_revision_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "moderation_policy_revision" add constraint "moderation_policy_revision_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "moderation_finding" add constraint "moderation_finding_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "moderation_finding" add constraint "moderation_finding_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "moderation_case" add constraint "moderation_case_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "moderation_case" add constraint "moderation_case_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "moderation_case" add constraint "moderation_case_subject_user_id_snowflake" check ("subject_user_id" is null or ("subject_user_id" ~ '^[1-9][0-9]{0,19}$' and "subject_user_id"::numeric <= 18446744073709551615));
alter table "moderation_case" add constraint "moderation_case_source_channel_id_snowflake" check ("source_channel_id" is null or ("source_channel_id" ~ '^[1-9][0-9]{0,19}$' and "source_channel_id"::numeric <= 18446744073709551615));
alter table "moderation_case" add constraint "moderation_case_source_message_id_snowflake" check ("source_message_id" is null or ("source_message_id" ~ '^[1-9][0-9]{0,19}$' and "source_message_id"::numeric <= 18446744073709551615));
alter table "moderation_action" add constraint "moderation_action_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "moderation_action" add constraint "moderation_action_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "moderation_action" add constraint "moderation_action_target_user_id_snowflake" check ("target_user_id" is null or ("target_user_id" ~ '^[1-9][0-9]{0,19}$' and "target_user_id"::numeric <= 18446744073709551615));
alter table "knowledge_entry" add constraint "knowledge_entry_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "knowledge_entry" add constraint "knowledge_entry_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "intake_event" add constraint "intake_event_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "intake_event" add constraint "intake_event_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "intake_event" add constraint "intake_event_author_user_id_snowflake" check ("author_user_id" is null or ("author_user_id" ~ '^[1-9][0-9]{0,19}$' and "author_user_id"::numeric <= 18446744073709551615));
alter table "intake_delivery" add constraint "intake_delivery_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "intake_delivery" add constraint "intake_delivery_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "guild_safety_state" add constraint "guild_safety_state_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "guild_safety_state" add constraint "guild_safety_state_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "guild_installation" add constraint "guild_installation_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "evidence_revision" add constraint "evidence_revision_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "evidence_revision" add constraint "evidence_revision_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "evidence_revision" add constraint "evidence_revision_source_channel_id_snowflake" check ("source_channel_id" is null or ("source_channel_id" ~ '^[1-9][0-9]{0,19}$' and "source_channel_id"::numeric <= 18446744073709551615));
alter table "evidence_revision" add constraint "evidence_revision_source_message_id_snowflake" check ("source_message_id" is null or ("source_message_id" ~ '^[1-9][0-9]{0,19}$' and "source_message_id"::numeric <= 18446744073709551615));
alter table "evidence_revision" add constraint "evidence_revision_original_author_user_id_snowflake" check ("original_author_user_id" is null or ("original_author_user_id" ~ '^[1-9][0-9]{0,19}$' and "original_author_user_id"::numeric <= 18446744073709551615));
alter table "conversation_request" add constraint "conversation_request_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "conversation_request" add constraint "conversation_request_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "conversation_request" add constraint "conversation_request_source_channel_id_snowflake" check ("source_channel_id" is null or ("source_channel_id" ~ '^[1-9][0-9]{0,19}$' and "source_channel_id"::numeric <= 18446744073709551615));
alter table "conversation_request" add constraint "conversation_request_source_message_id_snowflake" check ("source_message_id" is null or ("source_message_id" ~ '^[1-9][0-9]{0,19}$' and "source_message_id"::numeric <= 18446744073709551615));
alter table "channel_reply_settings" add constraint "channel_reply_settings_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "channel_reply_settings" add constraint "channel_reply_settings_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "capability_grant" add constraint "capability_grant_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "capability_grant" add constraint "capability_grant_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "audit_entry" add constraint "audit_entry_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "audit_entry" add constraint "audit_entry_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "artifact_record" add constraint "artifact_record_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "artifact_record" add constraint "artifact_record_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "artifact_record" add constraint "artifact_record_source_channel_id_snowflake" check ("source_channel_id" is null or ("source_channel_id" ~ '^[1-9][0-9]{0,19}$' and "source_channel_id"::numeric <= 18446744073709551615));
alter table "artifact_record" add constraint "artifact_record_source_message_id_snowflake" check ("source_message_id" is null or ("source_message_id" ~ '^[1-9][0-9]{0,19}$' and "source_message_id"::numeric <= 18446744073709551615));
alter table "ai_task" add constraint "ai_task_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "ai_task" add constraint "ai_task_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "action_attempt" add constraint "action_attempt_installation_scope_fk" foreign key ("installation_id", "guild_id") references "guild_installation" ("id", "guild_id") on delete no action deferrable initially deferred;
alter table "action_attempt" add constraint "action_attempt_guild_id_snowflake" check ("guild_id" is null or ("guild_id" ~ '^[1-9][0-9]{0,19}$' and "guild_id"::numeric <= 18446744073709551615));
alter table "intake_delivery" add constraint "intake_delivery_event_id_scope_fk" foreign key ("installation_id", "guild_id", "event_id") references "intake_event" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_case" add constraint "moderation_case_original_event_id_scope_fk" foreign key ("installation_id", "guild_id", "original_event_id") references "intake_event" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_case" add constraint "moderation_case_policy_revision_id_scope_fk" foreign key ("installation_id", "guild_id", "policy_revision_id") references "moderation_policy_revision" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_case" add constraint "moderation_case_expected_task_id_scope_fk" foreign key ("installation_id", "guild_id", "expected_task_id") references "ai_task" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "evidence_revision" add constraint "evidence_revision_case_id_scope_fk" foreign key ("installation_id", "guild_id", "case_id") references "moderation_case" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "evidence_revision" add constraint "evidence_revision_original_event_id_scope_fk" foreign key ("installation_id", "guild_id", "original_event_id") references "intake_event" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "evidence_revision" add constraint "evidence_revision_supersedes_evidence_id_scope_fk" foreign key ("installation_id", "guild_id", "supersedes_evidence_id") references "evidence_revision" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_finding" add constraint "moderation_finding_case_id_scope_fk" foreign key ("installation_id", "guild_id", "case_id") references "moderation_case" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_finding" add constraint "moderation_finding_policy_revision_id_scope_fk" foreign key ("installation_id", "guild_id", "policy_revision_id") references "moderation_policy_revision" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_finding" add constraint "moderation_finding_observation_task_result_id_scope_fk" foreign key ("installation_id", "guild_id", "observation_task_result_id") references "task_result" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_finding" add constraint "moderation_finding_assessment_task_result_id_scope_fk" foreign key ("installation_id", "guild_id", "assessment_task_result_id") references "task_result" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_action" add constraint "moderation_action_case_id_scope_fk" foreign key ("installation_id", "guild_id", "case_id") references "moderation_case" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_action" add constraint "moderation_action_policy_revision_id_scope_fk" foreign key ("installation_id", "guild_id", "policy_revision_id") references "moderation_policy_revision" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "action_attempt" add constraint "action_attempt_action_id_scope_fk" foreign key ("installation_id", "guild_id", "action_id") references "moderation_action" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "conversation_request" add constraint "conversation_request_expected_task_id_scope_fk" foreign key ("installation_id", "guild_id", "expected_task_id") references "ai_task" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "conversation_request" add constraint "conversation_request_accepted_result_reference_scope_fk" foreign key ("installation_id", "guild_id", "accepted_result_reference") references "task_result" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "knowledge_entry" add constraint "knowledge_entry_replacement_entry_id_scope_fk" foreign key ("installation_id", "guild_id", "replacement_entry_id") references "knowledge_entry" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "reply_delivery" add constraint "reply_delivery_request_id_scope_fk" foreign key ("installation_id", "guild_id", "request_id") references "conversation_request" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "reply_delivery" add constraint "reply_delivery_accepted_result_reference_scope_fk" foreign key ("installation_id", "guild_id", "accepted_result_reference") references "task_result" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "ai_task" add constraint "ai_task_prepared_input_id_scope_fk" foreign key ("installation_id", "guild_id", "prepared_input_id") references "prepared_input" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "ai_task" add constraint "ai_task_active_attempt_id_scope_fk" foreign key ("installation_id", "guild_id", "active_attempt_id") references "task_attempt" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "prepared_input" add constraint "prepared_input_task_id_scope_fk" foreign key ("installation_id", "guild_id", "task_id") references "ai_task" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "prepared_input" add constraint "prepared_input_source_event_id_scope_fk" foreign key ("installation_id", "guild_id", "source_event_id") references "intake_event" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "prepared_input" add constraint "prepared_input_policy_revision_id_scope_fk" foreign key ("installation_id", "guild_id", "policy_revision_id") references "moderation_policy_revision" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "prepared_input" add constraint "prepared_input_privacy_scope_id_disabled" check ("privacy_scope_id" is null);
alter table "task_attempt" add constraint "task_attempt_task_id_scope_fk" foreign key ("installation_id", "guild_id", "task_id") references "ai_task" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "task_attempt" add constraint "task_attempt_reservation_id_scope_fk" foreign key ("installation_id", "guild_id", "reservation_id") references "usage_reservation" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "task_result" add constraint "task_result_task_id_scope_fk" foreign key ("installation_id", "guild_id", "task_id") references "ai_task" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "task_result" add constraint "task_result_attempt_id_scope_fk" foreign key ("installation_id", "guild_id", "attempt_id") references "task_attempt" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "task_result" add constraint "task_result_usage_reservation_id_scope_fk" foreign key ("installation_id", "guild_id", "usage_reservation_id") references "usage_reservation" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "task_acceptance" add constraint "task_acceptance_task_id_scope_fk" foreign key ("installation_id", "guild_id", "task_id") references "ai_task" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "task_acceptance" add constraint "task_acceptance_result_id_scope_fk" foreign key ("installation_id", "guild_id", "result_id") references "task_result" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "usage_reservation" add constraint "usage_reservation_task_id_scope_fk" foreign key ("installation_id", "guild_id", "task_id") references "ai_task" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "usage_reservation" add constraint "usage_reservation_attempt_id_scope_fk" foreign key ("installation_id", "guild_id", "attempt_id") references "task_attempt" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "usage_reservation" add constraint "usage_reservation_usage_policy_id_scope_fk" foreign key ("installation_id", "guild_id", "usage_policy_id") references "usage_policy" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "usage_entry" add constraint "usage_entry_reservation_id_scope_fk" foreign key ("installation_id", "guild_id", "reservation_id") references "usage_reservation" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table "usage_entry" add constraint "usage_entry_attempt_id_scope_fk" foreign key ("installation_id", "guild_id", "attempt_id") references "task_attempt" ("installation_id", "guild_id", "id") on delete no action deferrable initially deferred;
alter table evidence_revision add constraint evidence_case_identity unique (installation_id, guild_id, case_id, id);
alter table "moderation_case" add constraint "moderation_case_current_evidence_fk" foreign key ("installation_id", "guild_id", "id", "current_evidence_revision_id") references "evidence_revision" ("installation_id", "guild_id", "case_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_finding" add constraint "moderation_finding_exact_evidence_fk" foreign key ("installation_id", "guild_id", "case_id", "evidence_revision_id") references "evidence_revision" ("installation_id", "guild_id", "case_id", "id") on delete no action deferrable initially deferred;
alter table "moderation_action" add constraint "moderation_action_exact_evidence_fk" foreign key ("installation_id", "guild_id", "case_id", "evidence_revision_id") references "evidence_revision" ("installation_id", "guild_id", "case_id", "id") on delete no action deferrable initially deferred;
alter table action_attempt add constraint action_attempt_owner_identity unique (installation_id, guild_id, action_id, id);
alter table "moderation_action" add constraint "moderation_action_active_attempt_fk" foreign key ("installation_id", "guild_id", "id", "active_attempt_id") references "action_attempt" ("installation_id", "guild_id", "action_id", "id") on delete no action deferrable initially deferred;
alter table moderation_action add constraint moderation_action_target_identity unique (installation_id, guild_id, target_user_id, id);
alter table "target_execution_state" add constraint "target_execution_state_action_fk" foreign key ("unresolved_installation_id", "guild_id", "target_user_id", "unresolved_action_id") references "moderation_action" ("installation_id", "guild_id", "target_user_id", "id") on delete no action deferrable initially deferred;
alter table target_execution_state add constraint target_unresolved_pair check ((unresolved_action_id is null) = (unresolved_installation_id is null));
alter table conversation_request add constraint conversation_accepted_result_identity unique (installation_id, guild_id, id, accepted_result_reference);
alter table "reply_delivery" add constraint "reply_delivery_accepted_result_fk" foreign key ("installation_id", "guild_id", "request_id", "accepted_result_reference") references "conversation_request" ("installation_id", "guild_id", "id", "accepted_result_reference") on delete no action deferrable initially deferred;

create function yuna_validate_action_findings() returns trigger language plpgsql as $$
declare
  action_key uuid;
  action_row moderation_action;
  evidence_row evidence_revision;
  policy_row moderation_policy_revision;
  finding_count integer;
  requires_available boolean := false;
  eligibility_at timestamptz;
begin
  if TG_TABLE_NAME = 'moderation_action' then
    action_key := coalesce(NEW.id, OLD.id);
  else
    action_key := coalesce(NEW.action_id, OLD.action_id);
  end if;
  select * into action_row from moderation_action where id = action_key;
  if not found then return null; end if;

  select count(*) into finding_count from moderation_action_finding where action_id = action_key;
  if action_row.origin = 'policy' and finding_count = 0 then
    raise exception 'Policy action requires contributing findings' using errcode = '23514';
  end if;
  if action_row.origin = 'staff' and finding_count <> 0 then
    raise exception 'Staff action cannot acquire policy authority through a finding link' using errcode = '23514';
  end if;
  if exists (
    select 1 from moderation_action_finding link join moderation_finding f on f.id = link.finding_id
    where link.action_id = action_key and
      (f.installation_id <> action_row.installation_id or f.guild_id <> action_row.guild_id or
       f.case_id is distinct from action_row.case_id or
       f.evidence_revision_id is distinct from action_row.evidence_revision_id or
       f.policy_revision_id is distinct from action_row.policy_revision_id)
  ) then
    raise exception 'Action findings must match exact scope, case, evidence and policy' using errcode = '23514';
  end if;
  if action_row.origin <> 'policy' then return null; end if;

  select * into evidence_row from evidence_revision where id = action_row.evidence_revision_id;
  if not found or evidence_row.original_author_user_id is distinct from action_row.target_user_id
     or evidence_row.author_kind not in ('user', 'bot') then
    raise exception 'Policy action must target the attributable original author' using errcode = '23514';
  end if;
  select * into policy_row from moderation_policy_revision where id = action_row.policy_revision_id;
  if not found then
    raise exception 'Policy action requires its immutable policy revision' using errcode = '23514';
  end if;
  if exists (
    select 1 from moderation_action_finding link join moderation_finding f on f.id = link.finding_id
    where link.action_id = action_key and (
      not (f.disposition = 'violation' or (action_row.kind = 'warning' and f.disposition = 'suspicion')) or
      not exists (
        select 1 from jsonb_array_elements(policy_row.action_mapping) mapping
        where mapping->>'ruleId' = f.rule_id
          and mapping->>'supportedDisposition' = f.disposition
          and mapping->>'action' = action_row.kind
          and (action_row.kind <> 'ban' or action_row.operation_payload is null or
            mapping->>'deleteMessageSeconds' = action_row.operation_payload->>'deleteMessageSeconds')
      )
    )
  ) then
    raise exception 'Every contributing finding must support the exact policy operation' using errcode = '23514';
  end if;

  -- A later mandatory purge must remain possible, including while an effect is unresolved.
  -- Recheck availability when preparing intent or claiming a new dispatch, not on outcome writes.
  if TG_TABLE_NAME = 'moderation_action' then
    if TG_OP = 'INSERT' then
      requires_available := action_row.state in ('READY', 'DISPATCHED');
      eligibility_at := NEW.created_at;
    elsif NEW.state = 'DISPATCHED' and NEW.execution_generation > OLD.execution_generation then
      requires_available := true;
      eligibility_at := NEW.updated_at;
    end if;
  end if;
  if requires_available then
    if evidence_row.payload_purged_at is not null or evidence_row.purge_after <= eligibility_at
       or action_row.payload_purged_at is not null or action_row.purge_after <= eligibility_at then
      raise exception 'New policy intent and dispatch require available original evidence and payload' using errcode = '23514';
    end if;
    if evidence_row.purge_after < action_row.purge_after then
      raise exception 'Action review cannot extend original evidence retention' using errcode = '23514';
    end if;
    if exists (
      select 1 from moderation_action_finding link join moderation_finding f on f.id = link.finding_id
      where link.action_id = action_key and
        (f.payload_purged_at is not null or f.purge_after <= eligibility_at or f.purge_after < action_row.purge_after)
    ) then
      raise exception 'Action review requires retained accepted explanations within their deadlines' using errcode = '23514';
    end if;
  end if;
  return null;
end $$;
create constraint trigger moderation_action_findings_required after insert or update on moderation_action
  deferrable initially deferred for each row execute function yuna_validate_action_findings();
create constraint trigger moderation_action_findings_scope after insert or update or delete on moderation_action_finding
  deferrable initially deferred for each row execute function yuna_validate_action_findings();

create function yuna_original_evidence_guard() returns trigger language plpgsql as $$
declare
  original_event intake_event;
  source_case moderation_case;
  previous_capture evidence_revision;
begin
  select * into original_event from intake_event where id = NEW.original_event_id;
  if not found or original_event.event_kind <> 'message_create' then
    raise exception 'Original evidence requires a captured message-create event' using errcode = '23514';
  end if;
  if original_event.installation_id <> NEW.installation_id or original_event.guild_id <> NEW.guild_id
     or original_event.author_kind <> NEW.author_kind
     or (NEW.original_author_user_id is not null and original_event.author_user_id is distinct from NEW.original_author_user_id) then
    raise exception 'Original evidence must preserve captured author and tenant provenance' using errcode = '23514';
  end if;
  if TG_OP = 'INSERT' and NEW.original_content is not null and original_event.content_access <> 'available' then
    raise exception 'Unavailable original content cannot be replaced with a later body' using errcode = '23514';
  end if;
  select * into source_case from moderation_case where id = NEW.case_id;
  if not found or source_case.installation_id <> NEW.installation_id or source_case.guild_id <> NEW.guild_id
     or source_case.source_channel_id <> NEW.source_channel_id or source_case.source_message_id <> NEW.source_message_id then
    raise exception 'Original evidence must retain its case source identity' using errcode = '23514';
  end if;

  if TG_OP = 'INSERT' then
    if NEW.supersedes_evidence_id is not null then
      select * into previous_capture from evidence_revision where id = NEW.supersedes_evidence_id;
      if not found or previous_capture.installation_id <> NEW.installation_id or previous_capture.guild_id <> NEW.guild_id
         or previous_capture.case_id <> NEW.case_id or previous_capture.original_event_id <> NEW.original_event_id
         or previous_capture.source_channel_id <> NEW.source_channel_id or previous_capture.source_message_id <> NEW.source_message_id then
        raise exception 'Capture completion requires the exact original predecessor' using errcode = '23514';
      end if;
      if NEW.capture_revision <> previous_capture.capture_revision + 1 or NEW.captured_at < previous_capture.captured_at
         or previous_capture.payload_purged_at is not null or previous_capture.purge_after <= NEW.captured_at
         or NEW.purge_after > previous_capture.purge_after then
        raise exception 'Capture completion cannot revive expired evidence or extend its retention' using errcode = '23514';
      end if;
      if (previous_capture.original_content is not null and previous_capture.original_content is distinct from NEW.original_content)
         or previous_capture.original_attachment_descriptors is distinct from NEW.original_attachment_descriptors then
        raise exception 'Capture completion cannot replace original body or attachments' using errcode = '23514';
      end if;
    end if;
  else
    if (to_jsonb(NEW) - array['original_content', 'original_attachment_descriptors', 'artifact_references', 'payload_purged_at', 'purge_reason'])
       is distinct from
       (to_jsonb(OLD) - array['original_content', 'original_attachment_descriptors', 'artifact_references', 'payload_purged_at', 'purge_reason']) then
      raise exception 'Original evidence identity and interpretation are immutable' using errcode = '23514';
    end if;
    if row(NEW.original_content, NEW.original_attachment_descriptors, NEW.artifact_references, NEW.payload_purged_at, NEW.purge_reason)
       is distinct from row(OLD.original_content, OLD.original_attachment_descriptors, OLD.artifact_references, OLD.payload_purged_at, OLD.purge_reason)
       and not (OLD.payload_purged_at is null and NEW.original_content is null and NEW.original_attachment_descriptors is null
         and NEW.artifact_references is null and NEW.payload_purged_at is not null and NEW.purge_reason is not null) then
      raise exception 'Original evidence can only be purged once, never edited' using errcode = '23514';
    end if;
  end if;
  return NEW;
end $$;
create constraint trigger evidence_original_guard after insert or update on evidence_revision
  deferrable initially deferred for each row execute function yuna_original_evidence_guard();

create function yuna_moderation_case_identity_guard() returns trigger language plpgsql as $$
begin
  if row(NEW.id, NEW.installation_id, NEW.guild_id, NEW.created_at, NEW.source_channel_id, NEW.source_message_id)
     is distinct from row(OLD.id, OLD.installation_id, OLD.guild_id, OLD.created_at, OLD.source_channel_id, OLD.source_message_id)
     or (OLD.original_event_id is not null and NEW.original_event_id is distinct from OLD.original_event_id) then
    raise exception 'Moderation case original source identity is immutable' using errcode = '23514';
  end if;
  return NEW;
end $$;
create constraint trigger moderation_case_identity_guard after update on moderation_case
  deferrable initially deferred for each row execute function yuna_moderation_case_identity_guard();

create function yuna_moderation_finding_guard() returns trigger language plpgsql as $$
declare policy_row moderation_policy_revision;
begin
  select * into policy_row from moderation_policy_revision where id = NEW.policy_revision_id;
  if not found or not exists (
    select 1 from jsonb_array_elements(policy_row.rules) rule
    where rule->>'id' = NEW.rule_id and rule->>'version' = NEW.rule_version
  ) then
    raise exception 'Finding must identify a rule in its exact policy revision' using errcode = '23514';
  end if;
  if TG_OP = 'UPDATE' then
    if (to_jsonb(NEW) - array['supported_facts', 'evidence_references', 'exclusions', 'coverage', 'payload_purged_at', 'purge_reason'])
       is distinct from
       (to_jsonb(OLD) - array['supported_facts', 'evidence_references', 'exclusions', 'coverage', 'payload_purged_at', 'purge_reason']) then
      raise exception 'Accepted finding identity and disposition are immutable' using errcode = '23514';
    end if;
    if row(NEW.supported_facts, NEW.evidence_references, NEW.exclusions, NEW.coverage, NEW.payload_purged_at, NEW.purge_reason)
       is distinct from row(OLD.supported_facts, OLD.evidence_references, OLD.exclusions, OLD.coverage, OLD.payload_purged_at, OLD.purge_reason)
       and not (OLD.payload_purged_at is null and NEW.supported_facts is null and NEW.evidence_references is null
         and NEW.exclusions is null and NEW.coverage is null and NEW.payload_purged_at is not null and NEW.purge_reason is not null) then
      raise exception 'Accepted finding payload can only be purged once, never edited' using errcode = '23514';
    end if;
  end if;
  return NEW;
end $$;
create constraint trigger moderation_finding_guard after insert or update on moderation_finding
  deferrable initially deferred for each row execute function yuna_moderation_finding_guard();

create function yuna_moderation_action_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(NEW) - array['state', 'execution_generation', 'active_attempt_id', 'next_attempt_at', 'outcome_summary',
       'row_revision', 'updated_at', 'operation_payload', 'payload_purged_at', 'purge_reason'])
     is distinct from
     (to_jsonb(OLD) - array['state', 'execution_generation', 'active_attempt_id', 'next_attempt_at', 'outcome_summary',
       'row_revision', 'updated_at', 'operation_payload', 'payload_purged_at', 'purge_reason']) then
    raise exception 'Moderation action intent, authority and evidence identity are immutable' using errcode = '23514';
  end if;
  if row(NEW.operation_payload, NEW.payload_purged_at, NEW.purge_reason)
     is distinct from row(OLD.operation_payload, OLD.payload_purged_at, OLD.purge_reason)
     and not (OLD.payload_purged_at is null and NEW.operation_payload is null and NEW.payload_purged_at is not null and NEW.purge_reason is not null) then
    raise exception 'Moderation action payload can only be purged once, never rewritten' using errcode = '23514';
  end if;
  if NEW.updated_at < OLD.updated_at or NEW.row_revision < OLD.row_revision then
    raise exception 'Action revision and observation time cannot move backwards' using errcode = '23514';
  end if;
  if NEW.state is distinct from OLD.state and (
    (OLD.state = 'READY' and NEW.state in ('DISPATCHED', 'CANCELED')) or
    (OLD.state = 'DISPATCHED' and NEW.state in ('UNKNOWN', 'CONFIRMED', 'FAILED')) or
    (OLD.state = 'UNKNOWN' and NEW.state in ('CONFIRMED', 'FAILED')) or
    (OLD.state = 'FAILED' and NEW.state = 'READY' and OLD.outcome_summary->>'classification' = 'definitive_failure')
  ) IS NOT TRUE then
    raise exception 'Action state transition would discard unresolved or terminal authority' using errcode = '23514';
  end if;
  if NEW.state = 'DISPATCHED' and OLD.state = 'READY' then
    if NEW.execution_generation <> OLD.execution_generation + 1 or NEW.active_attempt_id is null then
      raise exception 'Dispatch requires one new generation and its exact attempt' using errcode = '23514';
    end if;
  elsif NEW.execution_generation <> OLD.execution_generation then
    raise exception 'Execution generation can advance only when dispatch is claimed' using errcode = '23514';
  end if;
  if OLD.state in ('DISPATCHED', 'UNKNOWN') and NEW.active_attempt_id is distinct from OLD.active_attempt_id then
    raise exception 'An unresolved action cannot hand off its active attempt' using errcode = '23514';
  end if;
  return NEW;
end $$;
create constraint trigger moderation_action_intent_guard after update on moderation_action
  deferrable initially deferred for each row execute function yuna_moderation_action_guard();

create function yuna_moderation_policy_immutable() returns trigger language plpgsql as $$
begin
  if to_jsonb(NEW) is distinct from to_jsonb(OLD) then
    raise exception 'Published moderation policy is immutable; publish another revision' using errcode = '23514';
  end if;
  return NEW;
end $$;
create constraint trigger moderation_policy_immutable after update on moderation_policy_revision
  deferrable initially deferred for each row execute function yuna_moderation_policy_immutable();


-- A task's chosen input must name that same task. The existing unique task_id on
-- prepared_input and required references in both directions make the pairing reciprocal.
alter table prepared_input add constraint prepared_input_task_identity
  unique (installation_id, guild_id, task_id, id);
alter table ai_task add constraint ai_task_exact_input_fk
  foreign key (installation_id, guild_id, id, prepared_input_id)
  references prepared_input (installation_id, guild_id, task_id, id)
  on delete no action deferrable initially deferred;

-- An active attempt and terminal result cannot borrow another task's attempt or generation.
alter table task_attempt add constraint task_attempt_execution_identity
  unique (installation_id, guild_id, task_id, id, generation);
alter table ai_task add constraint ai_task_exact_active_attempt_fk
  foreign key (installation_id, guild_id, id, active_attempt_id, execution_generation)
  references task_attempt (installation_id, guild_id, task_id, id, generation)
  on delete no action deferrable initially deferred;
alter table task_result add constraint task_result_exact_attempt_fk
  foreign key (installation_id, guild_id, task_id, attempt_id, attempt_generation)
  references task_attempt (installation_id, guild_id, task_id, id, generation)
  on delete no action deferrable initially deferred;
alter table task_result add constraint task_result_task_identity
  unique (installation_id, guild_id, task_id, id);
alter table task_acceptance add constraint task_acceptance_exact_result_fk
  foreign key (installation_id, guild_id, task_id, result_id)
  references task_result (installation_id, guild_id, task_id, id)
  on delete no action deferrable initially deferred;

-- Before claim a reservation has no attempt_id. Once either side is claimed, both
-- references must identify the same task/attempt slot and accounted opportunity.
alter table usage_reservation add constraint usage_reservation_attempt_identity
  unique (installation_id, guild_id, task_id, attempt_number, id, attempt_id);
alter table task_attempt add constraint task_attempt_reservation_identity
  unique (installation_id, guild_id, task_id, attempt_number, reservation_id, id);
alter table task_attempt add constraint task_attempt_exact_reservation_fk
  foreign key (installation_id, guild_id, task_id, attempt_number, reservation_id, id)
  references usage_reservation (installation_id, guild_id, task_id, attempt_number, id, attempt_id)
  on delete no action deferrable initially deferred;
alter table usage_reservation add constraint usage_reservation_exact_attempt_fk
  foreign key (installation_id, guild_id, task_id, attempt_number, id, attempt_id)
  references task_attempt (installation_id, guild_id, task_id, attempt_number, reservation_id, id)
  on delete no action deferrable initially deferred;
alter table task_attempt add constraint task_attempt_usage_identity
  unique (installation_id, guild_id, task_id, id, reservation_id);
alter table task_result add constraint task_result_exact_usage_fk
  foreign key (installation_id, guild_id, task_id, attempt_id, usage_reservation_id)
  references task_attempt (installation_id, guild_id, task_id, id, reservation_id)
  on delete no action deferrable initially deferred;
alter table usage_reservation add constraint usage_reservation_claim_identity
  unique (installation_id, guild_id, id, attempt_id);
alter table usage_entry add constraint usage_entry_exact_attempt_fk
  foreign key (installation_id, guild_id, reservation_id, attempt_id)
  references usage_reservation (installation_id, guild_id, id, attempt_id)
  on delete no action deferrable initially deferred;
alter table usage_reservation add constraint usage_reservation_operation_identity
  unique (installation_id, guild_id, id, operation_kind, operation_key);
alter table usage_entry add constraint usage_entry_exact_operation_fk
  foreign key (installation_id, guild_id, reservation_id, operation_kind, operation_key)
  references usage_reservation (installation_id, guild_id, id, operation_kind, operation_key)
  on delete no action deferrable initially deferred;

-- Re-read committed transaction state: insert order is unrestricted, but a result
-- cannot be left on unfinished work or removed while its terminal task survives.
create function yuna_validate_task_execution() returns trigger language plpgsql as $$
declare
  old_task_id uuid;
  new_task_id uuid;
  task_key uuid;
  task_row ai_task;
  result_row task_result;
  attempt_row task_attempt;
  has_result boolean;
begin
  if TG_TABLE_NAME = 'ai_task' then
    if TG_OP <> 'INSERT' then old_task_id := OLD.id; end if;
    if TG_OP <> 'DELETE' then new_task_id := NEW.id; end if;
    if TG_OP = 'UPDATE' and OLD.state = 'TERMINAL' and NEW.state <> 'TERMINAL' then
      raise exception 'Terminal tasks cannot reopen' using errcode = '23514';
    end if;
  else
    if TG_OP <> 'INSERT' then old_task_id := OLD.task_id; end if;
    if TG_OP <> 'DELETE' then new_task_id := NEW.task_id; end if;
  end if;

  for task_key in select distinct value from unnest(array[old_task_id, new_task_id]) as ids(value) where value is not null loop
    select * into task_row from ai_task where id = task_key;
    -- A whole retained graph may be deleted after owner/usage retention permits it.
    -- The existing restrictive keys reject deleting just its referenced task.
    if not found then continue; end if;
    select * into result_row from task_result where task_id = task_key;
    has_result := found;
    if (task_row.state = 'TERMINAL') <> has_result then
      raise exception 'Terminal task requires exactly one result; nonterminal task must have none' using errcode = '23514';
    end if;
    if has_result and result_row.attempt_id is not null and result_row.attempt_generation <> task_row.execution_generation then
      raise exception 'Terminal result cannot use a superseded execution generation' using errcode = '23514';
    end if;
    if task_row.state = 'RUNNING' then
      select * into attempt_row from task_attempt where id = task_row.active_attempt_id;
      if not found or attempt_row.attempt_number <> task_row.attempt_count or attempt_row.state in ('finished', 'fenced') then
        raise exception 'Running task requires its live current attempt slot' using errcode = '23514';
      end if;
    end if;
  end loop;
  return null;
end $$;
create constraint trigger ai_task_execution_consistency after insert or update or delete on ai_task
  deferrable initially deferred for each row execute function yuna_validate_task_execution();
create constraint trigger task_result_execution_consistency after insert or update or delete on task_result
  deferrable initially deferred for each row execute function yuna_validate_task_execution();
create constraint trigger task_attempt_execution_consistency after insert or update or delete on task_attempt
  deferrable initially deferred for each row execute function yuna_validate_task_execution();

-- Retention may erase output, but cannot rewrite a completed execution into a different
-- result. Accepted owner content is independent of this payload and its cleanup schedule.
create function yuna_task_result_immutability() returns trigger language plpgsql as $$
begin
  if (to_jsonb(NEW) - array['payload', 'payload_unavailable', 'pending_owner_discard', 'payload_purged_at', 'purge_reason', 'row_revision', 'updated_at'])
     is distinct from
     (to_jsonb(OLD) - array['payload', 'payload_unavailable', 'pending_owner_discard', 'payload_purged_at', 'purge_reason', 'row_revision', 'updated_at']) then
    raise exception 'Terminal result identity and outcome are immutable' using errcode = '23514';
  end if;
  if NEW.payload is distinct from OLD.payload and not
     (NEW.payload is null and NEW.payload_unavailable and NEW.payload_purged_at is not null and NEW.purge_reason is not null) then
    raise exception 'Terminal result payload may only be purged' using errcode = '23514';
  end if;
  if OLD.payload_unavailable and
     (not NEW.payload_unavailable or row(NEW.payload_purged_at, NEW.purge_reason) is distinct from row(OLD.payload_purged_at, OLD.purge_reason)) then
    raise exception 'Result purge history cannot be reversed' using errcode = '23514';
  end if;
  return NEW;
end $$;
create trigger task_result_immutable before update on task_result
  for each row execute function yuna_task_result_immutability();

