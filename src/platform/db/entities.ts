/** Register baseline persistence entities separately from feature-specific entities so schema discovery is explicit. */
import { GuildInstallation } from '../../contexts/administration/entities/guild-installation.entity.js';
import { GuildSafetyState } from '../../contexts/administration/entities/guild-safety-state.entity.js';
import { CapabilityGrant } from '../../contexts/administration/entities/capability-grant.entity.js';
import { UsagePolicy } from '../../contexts/administration/entities/usage-policy.entity.js';
import { ModerationCase } from '../../contexts/moderation/entities/moderation-case.entity.js';
import { EvidenceRevision } from '../../contexts/moderation/entities/evidence-revision.entity.js';
import { ModerationFinding } from '../../contexts/moderation/entities/moderation-finding.entity.js';
import { ModerationPolicyRevision } from '../../contexts/moderation/entities/moderation-policy-revision.entity.js';
import { ModerationAction } from '../../contexts/moderation/entities/moderation-action.entity.js';
import { ActionAttempt } from '../../contexts/moderation/entities/action-attempt.entity.js';
import { TargetExecutionState } from '../../contexts/moderation/entities/target-execution-state.entity.js';
import { ConversationRequest } from '../../contexts/community/entities/conversation-request.entity.js';
import { ReplyDelivery } from '../../contexts/community/entities/reply-delivery.entity.js';
import { ChannelReplySettings } from '../../contexts/community/entities/channel-reply-settings.entity.js';
import { KnowledgeEntry } from '../../contexts/community/entities/knowledge-entry.entity.js';
import { AiTask } from '../jobs/entities/ai-task.entity.js';
import { PreparedInput } from '../jobs/entities/prepared-input.entity.js';
import { TaskAttempt } from '../jobs/entities/task-attempt.entity.js';
import { TaskResult } from '../jobs/entities/task-result.entity.js';
import { TaskAcceptance } from '../jobs/entities/task-acceptance.entity.js';
import { OutboxEntry } from '../jobs/entities/outbox-entry.entity.js';
import { UsageReservation } from '../usage/entities/usage-reservation.entity.js';
import { UsageEntry } from '../usage/entities/usage-entry.entity.js';
import { IntakeEvent } from '../intake/entities/intake-event.entity.js';
import { IntakeDelivery } from '../intake/entities/intake-delivery.entity.js';
import { ArtifactRecord } from '../artifacts/entities/artifact-record.entity.js';
import { AuditEntry } from '../audit/entities/audit-entry.entity.js';
import { ActionPlan } from '../../contexts/administration/entities/action-plan.entity.js';
import { PlanApproval } from '../../contexts/administration/entities/plan-approval.entity.js';
import { CustodianEnrollment } from '../../contexts/administration/entities/custodian-enrollment.entity.js';
import { MemoryScope } from '../../contexts/memory/entities/memory-scope.entity.js';
import { MemoryFact } from '../../contexts/memory/entities/memory-fact.entity.js';
import { FactEmbedding } from '../../contexts/memory/entities/fact-embedding.entity.js';
import { MemoryDeletionRequest } from '../../contexts/memory/entities/memory-deletion-request.entity.js';
import { DebateSession } from '../../contexts/debates/entities/debate-session.entity.js';
import { ParticipantConsent } from '../../contexts/debates/entities/participant-consent.entity.js';
import { TranscriptEntry } from '../../contexts/debates/entities/transcript-entry.entity.js';
import { TranscriptSnapshot } from '../../contexts/debates/entities/transcript-snapshot.entity.js';
import { RubricRevision } from '../../contexts/debates/entities/rubric-revision.entity.js';
import { DebateEvaluation } from '../../contexts/debates/entities/debate-evaluation.entity.js';

/** Schema composition only; feature services must not import this cross-context catalogue. */
export const coreEntities = [
  GuildInstallation, GuildSafetyState, CapabilityGrant, UsagePolicy,
  ModerationCase, EvidenceRevision, ModerationFinding, ModerationPolicyRevision, ModerationAction, ActionAttempt, TargetExecutionState,
  ConversationRequest, ReplyDelivery, ChannelReplySettings, KnowledgeEntry,
  AiTask, PreparedInput, TaskAttempt, TaskResult, TaskAcceptance, OutboxEntry,
  UsageReservation, UsageEntry,
  IntakeEvent, IntakeDelivery,
  ArtifactRecord,
  AuditEntry,
  MemoryScope, MemoryFact, MemoryDeletionRequest,
  DebateSession, ParticipantConsent, TranscriptEntry, TranscriptSnapshot, RubricRevision, DebateEvaluation,
];

/** Opt-in metadata does not enable staged product workflows or deploy their tables. */
export const stagedEntities = [
  ActionPlan, PlanApproval, CustodianEnrollment,
  FactEmbedding,
];

export const allEntities = [...coreEntities, ...stagedEntities];
