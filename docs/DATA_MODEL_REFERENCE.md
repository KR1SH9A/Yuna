# Yuna data model reference

A lookup for **36 existing entity concepts and 4 proposed additions**. The TypeScript sources contain design comments only; none of these models is implemented. This reference distinguishes the current scaffold from the target changes in the [architecture plan](ARCHITECTURE_PLAN.md). Request and response DTOs are cataloged separately in the [DTO and module reference](DTO_REFERENCE.md); they do not add entity models or tables.

**Read an entry:** “Scaffold fields” and “Entity methods” reflect the current source. “Writer,” “Relations” and “Lifecycle” describe the intended ownership and clarify design choices. “Plan change” is proposed work, not a claim that the source was updated. New models have no entity file yet.

## Shared conventions

- Internal IDs are UUIDs; Discord IDs are strings. All tenant-owned references must match guild and applicable installation generation. Use database-enforced keys/constraints, not only application checks.
- Row revisions prevent lost updates; business/source revisions establish validity; execution generations fence stale workers. They are different values.
- Cross-context references are IDs and immutable contract values, not exported ORM objects. Only the owning service writes a context's tables. A service can coordinate several entities.
- “Immutable” means facts do not change while retained. It does not prohibit deleting private payload under its retention policy. Preserve only permitted minimal lineage/tombstones afterward.
- A missing field value must have defined meaning: for example, a canceled task can have no provider attempt, and a staff unban can have no AI finding. Do not fabricate rows to satisfy an inappropriate universal relationship.
- The field lists are conceptual, not migration-ready schemas. Names, types, indexes, explicit nullability and retention durations must be finalized with the first implementation slice.

## Quick lookup

Core means recommended for the initial text/conversation/moderation release, not “currently running.” Optional governance, Memory and Debates do not require migrations until selected. The four additions are core recovery/storage records; no service-per-model rule follows from this list.

| Model | Owner | Scope | What it records |
| --- | --- | --- | --- |
| [GuildInstallation](#guildinstallation) | Administration | Core | Guild installation generation and whether new work is admitted. |
| [GuildSafetyState](#guildsafetystate) | Administration | Core | Single lockable per-guild pause/dispatch gate. |
| [CapabilityGrant](#capabilitygrant) | Administration | Core | Guild-scoped Yuna capability for a named grantee, target/channel scope and validity period. |
| [UsagePolicy](#usagepolicy) | Administration | Core | Versioned shared feature/provider limits and spending windows. |
| [ActionPlan](#actionplan) | Administration | Optional governance | Exact immutable sensitive operation plan plus governed one-time authorization lifecycle. |
| [PlanApproval](#planapproval) | Administration | Optional governance | One eligible person approval bound to exact plan content and authority validity. |
| [CustodianEnrollment](#custodianenrollment) | Administration | Optional governance | Nominee acceptance and eligibility workflow before optional custodian authority creation. |
| [ModerationCase](#moderationcase) | Moderation | Core | Canonical incident and expected AI stage, with workflow progress separate from evidential disposition. |
| [EvidenceRevision](#evidencerevision) | Moderation | Core | Immutable captured source content/provenance, distinct from later observations and findings. |
| [ModerationFinding](#moderationfinding) | Moderation | Core | Immutable accepted interpretation of exact evidence/rule versions, separate from later staff actions and external outcomes. |
| [ModerationPolicyRevision](#moderationpolicyrevision) | Moderation | Core | Immutable version of guild moderation rules, exclusions, evidence requirements and action mapping. |
| [ModerationAction](#moderationaction) | Moderation | Core | One durable logical ban, unban, warning or optional kick intent across delivery attempts. |
| [ActionAttempt](#actionattempt) | Moderation | Core | One dispatch claim plus known send, response and reconciliation facts. |
| [TargetExecutionState](#targetexecutionstate) | Moderation | Core | Serialize conflicting ban/unban work for one guild/account across cases, retries and staff actions. |
| [ConversationRequest](#conversationrequest) | Community | Core | One bounded reply workflow, including expected AI stage and cancellation/delivery state. |
| [ReplyDelivery](#replydelivery) | Community | Core | Accepted reply publication intent and its actual or ambiguous Discord outcome. |
| [ChannelReplySettings](#channelreplysettings) | Community | Core | Per-channel reply mode and allowed approved-knowledge scope. |
| [KnowledgeEntry](#knowledgeentry) | Community | Core | Approved guild information with provenance, visibility and retirement. |
| [MemoryScope](#memoryscope) | Memory | Staged Memory | One guild/user purpose-specific consent, audience and privacy control boundary. |
| [MemoryFact](#memoryfact) | Memory | Staged Memory | Accepted personal fact bound to subject, consent, provenance, audience and expiry. |
| [FactEmbedding](#factembedding) | Memory | Staged Memory; optional indexing | Model-specific vector for one exact permitted fact content. |
| [MemoryDeletionRequest](#memorydeletionrequest) | Memory | Staged Memory | Retryable progress for removal of personal content copied across managed storage owners. |
| [DebateSession](#debatesession) | Debates | Staged Debates | Consented session phase and frozen transcript/rubric/evaluation identity. |
| [ParticipantConsent](#participantconsent) | Debates | Staged Debates | Participant decision on exact debate processing/visibility scope. |
| [TranscriptEntry](#transcriptentry) | Debates | Staged Debates | Ordered attributable source item or explicit edit/deletion/gap marker. |
| [TranscriptSnapshot](#transcriptsnapshot) | Debates | Staged Debates | Frozen ordered declared transcript plus hash and coverage. |
| [RubricRevision](#rubricrevision) | Debates | Staged Debates | Immutable agreed criteria, weights and outcome configuration for debate scoring. |
| [DebateEvaluation](#debateevaluation) | Debates | Staged Debates | Accepted criterion evidence, deterministic totals/outcome and distinct publication state. |
| [AiTask](#aitask) | Jobs | Core | One immutable inference request and the authoritative technical execution lifecycle. |
| [PreparedInput](#preparedinput) | Jobs | Core | Minimal immutable task payload with a mutable eligibility and deletion gate. |
| [TaskAttempt](#taskattempt) | Jobs | Core | One executor claim and provider execution opportunity, including ambiguous failure. |
| [TaskResult](#taskresult) | Jobs | Core | One terminal outcome for the logical task, independently of feature acceptance. |
| [TaskAcceptance](#taskacceptance) | Jobs | Core | The feature owner acknowledgment of a terminal task outcome. |
| [OutboxEntry](#outboxentry) | Jobs | Core | Durable publication intent created with the state change it announces. |
| [UsageReservation](#usagereservation) | Usage | Core | Bounded budget capacity held for a planned attempt or explicit feature operation. |
| [UsageEntry](#usageentry) | Usage | Core | Known actual usage or unresolved estimated liability for one provider attempt. |
| [IntakeEvent](#intakeevent) | Bot ingress | Proposed addition | The durable, bounded record of input before feature branching. |
| [IntakeDelivery](#intakedelivery) | Bot ingress | Proposed addition | Independent acknowledgment that one feature durably handled an event. |
| [ArtifactRecord](#artifactrecord) | Artifacts | Proposed addition | Metadata that makes uploaded bytes attributable, authorized and recoverably deletable. |
| [AuditEntry](#auditentry) | Audit | Proposed addition | Bounded trusted history of local changes and observed external outcomes. |

## Main relationships

| Parent | Related records | Why they are separate |
| --- | --- | --- |
| IntakeEvent | One receipt per intended feature | One feature can finish while another still needs recovery |
| ModerationCase | Many evidence revisions, findings and action intents | Captured evidence, accepted interpretation and an external action have different meanings |
| ModerationAction | Many ActionAttempt records | One intent may have multiple bounded attempts and unresolved effects |
| ConversationRequest | Historical tasks; at most one initial logical ReplyDelivery | Deciding a reply and confirming its publication are separate lifecycles |
| AiTask | One input; many attempts; one terminal result; at most one acknowledgment | Execution retries do not repeat business acceptance |
| MemoryScope | Facts, optional vectors and deletion requests | Consent, retained content, indexing and cleanup have different lifecycles |
| DebateSession | Consents, transcript entries/snapshots and evaluations | Participation, captured evidence, scoring and publication are distinct |
| ActionPlan | Multiple independent approvals | An approval is evidence; the plan consumes authorization once |

A conceptual relationship does not require an ORM navigation property. Prefer explicit queries owned by the relevant context.

## Administration

### GuildInstallation

Guild installation generation and whether new work is admitted. **Scope: Core.** [Current scaffold](../src/contexts/administration/entities/guild-installation.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | GuildLifecycleService; proposed updateUsagePolicy/setFeatureAdmission coordinate installation configuration. |
| Scaffold fields | `id`; `guildId`; `state including active/suspended/removing/removed`; `installationGeneration`; `configurationReferences`; `registeredAt`; `removedAt`; `revision`; `updatedAt` |
| Relations | One active installation scope per guild; many grants and feature records. Safety and usage policy are guild settings. Every work/grant binding includes installation generation; cleanup acknowledgments name each required owner. |
| Lifecycle | Mutable active/suspended/removing/removed state with installation generation. Reinstall requires deliberate reactivation and never revives old tasks automatically. |
| Entity methods | `activate`, `suspend`, `beginRemoval`, `completeRemoval` |
| Plan change | Add feature admission settings and recorded required-owner cleanup acknowledgments. Removal advances the generation before cleanup. Registration invokes verified owner bootstrap; reinstallation cannot reuse old grants or work. |

### GuildSafetyState

Single lockable per-guild pause/dispatch gate. **Scope: Core.** [Current scaffold](../src/contexts/administration/entities/guild-safety-state.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | SafetyService |
| Scaffold fields | `guildId as unique key`; `pauseState`; `monotonicRevision`; `reason`; `actorAuthorityReference`; `changedAt`; `rowRevision` |
| Relations | 1 safety state -> 1 guild (GuildInstallation); 1 safety revision -> many admitted effects (ModerationAction / ReplyDelivery) |
| Lifecycle | Mutable pause state and monotonic revision. Pause/resume both advance revision; resumption cannot reactivate old intents automatically. |
| Entity methods | `pause`, `resume` |
| Plan change | Keep the public lock/read gate. Pause and dispatch claims use the same row; resume advances the revision and does not revive canceled work. |

### CapabilityGrant

Guild-scoped Yuna capability for a named grantee, target/channel scope and validity period. **Scope: Core.** [Current scaffold](../src/contexts/administration/entities/capability-grant.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | AuthorityService; grantCapability/bootstrapOwner are proposed additions. Optional GovernanceService coordinates enrollment. |
| Scaffold fields | `id`; `guildId`; `granteePrincipal`; `capability`; `target/channel scope`; `grantorPrincipal`; `grantedAt`; `expiresAt`; `revokedAt`; `authorityRevision`; `revocationReason`; `revision` |
| Relations | many grants -> 1 guild installation scope (GuildInstallation); many grants -> 1 grantee; each grant records its grantor (External principal); 1 grant/revision can validate many authority decisions (StaffRequestAuthority / PlanApproval binding) |
| Lifecycle | Mutable revocation state around a scoped grant; expiry/currentness checked by policy and service. Revoked authority cannot revive through old snapshots. |
| Entity methods | `revoke`, `isCurrentFor` |
| Plan change | Add installationGeneration to the grant binding. Add AuthorityService.bootstrapOwner and grantCapability. Lock current authority during local claim/revocation; names, model prose and native permission alone do not create a Yuna grant. |

### UsagePolicy

Versioned shared feature/provider limits and spending windows. **Scope: Core.** [Current scaffold](../src/contexts/administration/entities/usage-policy.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | Proposed GuildLifecycleService.updateUsagePolicy; UsageService consumes policy but never edits it. |
| Scaffold fields | `id`; `guildId`; `featureLimits`; `providerLimits`; `spendWindow`; `spendCeilings`; `revision`; `effectiveAt`; `updatedAt` |
| Relations | One current policy per guild; many reservations retain immutable policy revision/limit snapshots. No accounting counters or provider bills live here. |
| Lifecycle | Mutable versioned configuration; coherent authorized revisions leave admitted reservations and actual costs intact. |
| Entity methods | `revise` |
| Plan change | GuildLifecycleService.updateUsagePolicy owns authorized revision changes. Reservation admission and policy changes serialize; existing reservations retain the original policy binding and liability. |

### ActionPlan

Exact immutable sensitive operation plan plus governed one-time authorization lifecycle. **Scope: Optional governance.** [Current scaffold](../src/contexts/administration/entities/action-plan.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | GovernanceService |
| Scaffold fields | `id`; `guildId`; `exactOperations`; `planHash`; `requesterId`; `scope`; `expiresAt`; `authorityBinding`; `status`; `consumedAt`; `consumptionReference`; `revision`; `createdAt` |
| Relations | 1 plan -> 0..N distinct approver records (PlanApproval); an enrollment can use 1 governing plan; current direct plan linkage is unspecified (CustodianEnrollment); 1 plan -> exact bounded operations; consumption points to execution identity (Feature-owned operation) |
| Lifecycle | Operation payload/hash immutable. Current model mutates plan consumption/invalidation state and consumes authorization once. |
| Entity methods | `consume`, `invalidate` |
| Plan change | Keep one-time authorization consumption here. Consume the exact approved plan atomically with durable owner operation intent; a crash must not spend authorization without leaving executable/recoverable intent. |

### PlanApproval

One eligible person approval bound to exact plan content and authority validity. **Scope: Optional governance.** [Current scaffold](../src/contexts/administration/entities/plan-approval.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | GovernanceService |
| Scaffold fields | `id`; `guildId`; `planId`; `planHash`; `approverId`; `approverAuthorityRevision`; `scope`; `approvedAt`; `expiresAt`; `consumedAt`; `invalidatedAt`; `invalidationReason`; `revision` |
| Relations | many approvals -> 1 exact plan (ActionPlan); many approvals -> 1 approver with bound authority revision (External principal / authority binding) |
| Lifecycle | Approval binds exact plan/hash and approver authority. Proposed target retains invalidation evidence but no separate consumption state. |
| Entity methods | `consume`, `invalidate` |
| Plan change | Remove consumedAt and consume in the target design. Keep explicit invalidation/withdrawal evidence where required. ActionPlan alone owns execution consumption; current approver authority is still checked. |

### CustodianEnrollment

Nominee acceptance and eligibility workflow before optional custodian authority creation. **Scope: Optional governance.** [Current scaffold](../src/contexts/administration/entities/custodian-enrollment.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | GovernanceService |
| Scaffold fields | `id`; `guildId`; `candidateId`; `proposerId`; `governanceRevision`; `approvalReferences`; `candidateAcceptedAt`; `status`; `resultingGrantReference`; `completedAt`; `rejectedAt`; `rejectionReason`; `revision` |
| Relations | 1 enrollment -> required eligible approval references (PlanApproval); 1 completed enrollment -> 1 resulting grant reference (CapabilityGrant); 1 enrollment -> candidate and proposer identities (External principal) |
| Lifecycle | Mutable nomination acceptance, completion or rejection. Acceptance is not a grant or an independent approval. |
| Entity methods | `recordAcceptance`, `complete`, `reject` |
| Plan change | No new abstraction. Complete enrollment, create the grant and consume its governing plan in one local transaction when optional governance is enabled. |

## Moderation

### ModerationCase

Canonical incident and expected AI stage, with workflow progress separate from evidential disposition. **Scope: Core.** [Current scaffold](../src/contexts/moderation/entities/moderation-case.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | ModerationService |
| Scaffold fields | `id`; `guildId`; `subjectUserId`; `incidentKey`; `workflowPhase`; `disposition`; `currentEvidenceRevision`; `policyRevision`; `expectedTaskId`; `generation`; `revision`; `createdAt`; `updatedAt` |
| Relations | 1 case -> 0..N evidence revisions; 0..1 current revision (EvidenceRevision); 1 case -> 0..N accepted findings (ModerationFinding); 1 case -> 0..N intents (ModerationAction); many cases -> 1 bound policy revision (ModerationPolicyRevision); 1 case -> many historical tasks; 0..1 expected task (AiTask (Jobs)) |
| Lifecycle | Mutable canonical aggregate. New source content advances evidence/generation; expected-stage acceptance is conditional. Historical finding data is retained separately. |
| Entity methods | `replaceEvidenceRevision`, `expectTask`, `acceptFinding`, `recordDisposition` |
| Plan change | Link source intake identity for traceability. Current policy is the latest committed guild policy revision. Evidence/policy changes supersede expected tasks and pending automatic effects. Workflow phase and evidential disposition remain separate. |

### EvidenceRevision

Immutable captured source content/provenance, distinct from later observations and findings. **Scope: Core.** [Current scaffold](../src/contexts/moderation/entities/evidence-revision.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | ModerationService |
| Scaffold fields | `id`; `guildId`; `caseId`; `revision`; `sourceKind`; `sourceIds`; `originalAuthorId`; `reporterId when present`; `capturedText or controlled snapshot reference`; `contentHash`; `source/capture timestamps`; `inspected coverage and gaps`; `expiresAt` |
| Relations | many revisions -> 1 case (ModerationCase); 1 revision -> 0..N findings (ModerationFinding); 1 revision -> 0..N controlled retained artifacts (Artifact reference (Platform)) |
| Lifecycle | Immutable while retained. Source changes create new records; retention may remove content without rewriting captured history. |
| Entity methods | None; immutable data or service-coordinated persistence. |
| Plan change | Use captureCoverage for captured-source availability; model-inspected coverage belongs to the observation result. Add explicit owner retention/purge progress where needed. An editable source URL alone is not retained evidence. |

### ModerationFinding

Immutable accepted interpretation of exact evidence/rule versions, separate from later staff actions and external outcomes. **Scope: Core.** [Current scaffold](../src/contexts/moderation/entities/moderation-finding.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | ModerationService |
| Scaffold fields | `id`; `guildId`; `caseId`; `evidenceRevision`; `ruleId`; `ruleVersion`; `observationResultId`; `assessmentResultId`; `supportedFacts`; `exclusions`; `disposition`; `acceptedAt` |
| Relations | many findings -> 1 case (ModerationCase); many findings -> 1 exact evidence revision (EvidenceRevision); 1 finding -> observation result plus assessment result (TaskResult (Jobs)); many findings may support 1 logical ban; a finding can be referenced by historical action records (ModerationAction) |
| Lifecycle | Immutable accepted record. Reassessment produces a new finding against current bindings; staff unban does not alter the original assessment. |
| Entity methods | None; immutable data or service-coordinated persistence. |
| Plan change | Keep immutable accepted facts. New actions revalidate current evidence/policy and authority. Retention can erase payload while preserving permitted non-content lineage; staff unban does not rewrite the finding. |

### ModerationPolicyRevision

Immutable version of guild moderation rules, exclusions, evidence requirements and action mapping. **Scope: Core.** [Current scaffold](../src/contexts/moderation/entities/moderation-policy-revision.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | Proposed ModerationService.publishPolicyRevision; no current publication method is specified. |
| Scaffold fields | `id`; `guildId`; `revision`; `enabledRules`; `requiredEvidence`; `exclusions`; `evaluationConfigurationVersions`; `actionMapping`; `activationTime`; `createdAt` |
| Relations | 1 policy revision -> 0..N bound cases (ModerationCase); 1 policy revision -> 0..N policy-authorized actions (ModerationAction); 1 guild -> many historical revisions; one active revision is intended but not modeled explicitly (GuildInstallation configuration reference) |
| Lifecycle | Immutable retained revision; changes publish a new revision. Activation must invalidate affected pending decisions. |
| Entity methods | None; immutable data or service-coordinated persistence. |
| Plan change | Add ModerationService.publishPolicyRevision. Publishing immediately activates the next serialized guild revision; rollback publishes a new revision. Do not add a separate active-policy record yet. |

### ModerationAction

One durable logical ban, unban, warning or optional kick intent across delivery attempts. **Scope: Core.** [Current scaffold](../src/contexts/moderation/entities/moderation-action.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | BanService, WarningService, KickService (optional) |
| Scaffold fields | `id`; `guildId`; `caseId`; `findingReferences`; `targetUserId`; `kind`; `authorityOrigin/binding`; `evidenceRevision`; `policyRevision`; `deduplicationKey`; `state`; `generation`; `auditReference`; `operationResult`; `revision`; `createdAt`; `updatedAt` |
| Relations | One intent → zero or many ActionAttempt records. Automatic intent → one case and one or more supporting findings. Staff intent may have no case/finding. Many historical ban/unban intents share one TargetExecutionState. |
| Lifecycle | Mutable intent: ready, dispatched, confirmed, definitive failure, unknown or canceled as appropriate. Lifecycle is separate from operation result and attempt history. |
| Entity methods | `claimDispatch`, `recordOutcome`, `cancelBeforeDispatch`, `recordReconciliation` |
| Plan change | Make origin-dependent requirements explicit: automatic actions require case, accepted findings and evidence/policy bindings; ordinary staff actions require exact current staff authority and may omit a case/finding. Keep the intent separate from attempts. |

### ActionAttempt

One dispatch claim plus known send, response and reconciliation facts. **Scope: Core.** [Current scaffold](../src/contexts/moderation/entities/action-attempt.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | BanService, WarningService, KickService (optional) |
| Scaffold fields | `id`; `guildId`; `actionId`; `attemptNumber`; `dispatchGeneration`; `claimedAt`; `sentAt if known`; `completedAt`; `requestFingerprint`; `responseClass`; `providerRequestReference if available`; `reconciliationEvidence`; `revision` |
| Relations | many attempts -> 1 logical intent (ModerationAction) |
| Lifecycle | Append/complete factual attempt record. Send acknowledgment, external effect and reconciliation evidence remain distinct; updates are generation-fenced. |
| Entity methods | `markSent`, `recordResponse`, `recordReconciliation` |
| Plan change | Preserve this separate record. Its claim, known send, response and reconciliation evidence are different facts. A missing sentAt cannot prove no request occurred. |

### TargetExecutionState

Serialize conflicting ban/unban work for one guild/account across cases, retries and staff actions. **Scope: Core.** [Current scaffold](../src/contexts/moderation/entities/target-execution-state.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | BanService |
| Scaffold fields | `guildId`; `targetUserId as composite key`; `generation`; `unresolvedActionId`; `revision`; `updatedAt` |
| Relations | 1 target state -> 0..1 currently unresolved action; many historical actions share the key (ModerationAction) |
| Lifecycle | Mutable lockable state with monotonic generation; claim, retain uncertainty and release only after established resolution. |
| Entity methods | `claim`, `retainUnresolved`, `releaseResolved` |
| Plan change | Keep the shared ban/unban serialization key across cases and staff actions. An unknown outcome retains the unresolved action even after a lease expires. If kick ships, explicitly decide which conflicting operations share this gate. |

## Community

### ConversationRequest

One bounded reply workflow, including expected AI stage and cancellation/delivery state. **Scope: Core.** [Current scaffold](../src/contexts/community/entities/conversation-request.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | ConversationService, ReplyDeliveryService |
| Scaffold fields | `id`; `guildId`; `channelId`; `trustedSource`; `authorId`; `sourceRevision`; `stage`; `expectedTaskId`; `acceptedResultReference`; `audienceBinding`; `context/provenance references`; `deadline`; `cancellationGeneration`; `revision`; `createdAt`; `updatedAt` |
| Relations | 1 request -> many historical tasks; 0..1 expected task (AiTask (Jobs)); 1 request -> 0..1 accepted reply result (TaskResult (Jobs)); 1 request -> 0..1 logical reply delivery initially (ReplyDelivery); 1 request -> 0..N bounded context references (KnowledgeEntry / authorized Memory values) |
| Lifecycle | Mutable bounded stage machine. Source revisions and cancellation fence pending work; delivered state requires actual delivery evidence. |
| Entity methods | `expectTask`, `acceptReply`, `cancel`, `markDelivered` |
| Plan change | Add intakeEventId/intakeDeliveryId, settingsRevision and selected knowledge entry revision bindings. Copy the intake reply deadline without extension. Validate source, installation, audience, optional memory and selected knowledge at acceptance and dispatch. |

### ReplyDelivery

Accepted reply publication intent and its actual or ambiguous Discord outcome. **Scope: Core.** [Current scaffold](../src/contexts/community/entities/reply-delivery.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | ReplyDeliveryService |
| Scaffold fields | `id`; `guildId`; `requestId`; `acceptedResultReference`; `destination`; `privacy/audience binding`; `deliveryState`; `generation`; `attemptMetadata`; `discordMessageId when known`; `outcomeDetails`; `revision`; `createdAt`; `updatedAt` |
| Relations | One request → zero or one logical delivery. A delivery binds exactly one accepted generation result and zero or one confirmed Discord message; uncertain attempts remain recorded. |
| Lifecycle | Mutable local delivery state with generation and attempt metadata; cancel only before dispatch, otherwise reconcile ambiguity. |
| Entity methods | `claimDispatch`, `recordOutcome`, `cancelBeforeDispatch`, `recordReconciliation` |
| Plan change | Add explicit deadline and selected settings/knowledge revision bindings. Enforce one logical delivery per initial request. No new send after expiry; reconcile already in-flight or unknown sends. Keep bounded attempt metadata inline initially. |

### ChannelReplySettings

Per-channel reply mode and allowed approved-knowledge scope. **Scope: Core.** [Current scaffold](../src/contexts/community/entities/channel-reply-settings.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | Proposed ConversationService.updateChannelReplySettings; no current service writer is specified. |
| Scaffold fields | `id`; `guildId`; `channelId`; `mode`; `allowedKnowledgeScope`; `revision`; `updatedAt` |
| Relations | 1 settings record -> 1 guild/channel (Discord guild/channel); 1 channel configuration -> many request eligibility evaluations (ConversationRequest) |
| Lifecycle | Mutable versioned settings; mode/scope changes require prior authorization and expected revision. |
| Entity methods | `changeMode`, `changeKnowledgeScope` |
| Plan change | ConversationService.updateChannelReplySettings owns authorized changes and invalidates affected pending work. Unique (guildId, channelId). Keep settings out of the Discord adapter. |

### KnowledgeEntry

Approved guild information with provenance, visibility and retirement. **Scope: Core.** [Current scaffold](../src/contexts/community/entities/knowledge-entry.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | KnowledgeService |
| Scaffold fields | `id`; `guildId`; `content`; `provenance`; `approvalActorId`; `approvedAt`; `visibility`; `revision`; `retiredAt`; `createdAt`; `updatedAt` |
| Relations | 1 entry revision -> 0..N prepared request context references (ConversationRequest); 1 entry -> provenance and approval actor reference (External source/Discord principal) |
| Lifecycle | Mutable approval/retirement metadata bound to exact content revision. Content edits cannot silently retain approval. |
| Entity methods | `approve`, `retire` |
| Plan change | Add KnowledgeService.updateVisibility; content approval remains bound to its exact revision. Retirement or access narrowing invalidates pending uses, including already generated but unsent replies. |

## Memory

Staged: enable only after the complete task, acceptance, retention and removal paths exist.

### MemoryScope

One guild/user purpose-specific consent, audience and privacy control boundary. **Scope: Staged Memory.** [Current scaffold](../src/contexts/memory/entities/memory-scope.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | MemoryService |
| Scaffold fields | `id`; `guildId`; `userId`; `purposeSpecificConsent`; `allowedAudiences`; `privacyRevision`; `retentionConfiguration`; `rowRevision`; `createdAt`; `updatedAt` |
| Relations | 1 scope -> 0..N facts (MemoryFact); 1 scope -> 0..N deletion operations (MemoryDeletionRequest); 1 scope revision -> 0..N pending work/disclosure bindings (PreparedInput / disclosure bindings) |
| Lifecycle | Mutable consent and monotonic privacy revision. Scope changes fence pending derived work and disclosure. |
| Entity methods | `grantConsent`, `revokeConsent`, `advancePrivacyRevision` |
| Plan change | Unique (guildId, userId). Treat privacyRevision as a pending-work/disclosure fence. Current consent, existence, audience and expiry determine whether surviving facts remain usable; unrelated deletion does not demand re-embedding all facts. Concurrent one-shot proposals use owner-supplied operation keys and retained source-validity metadata, not one global expected-task slot on this scope. |

### MemoryFact

Accepted personal fact bound to subject, consent, provenance, audience and expiry. **Scope: Staged Memory.** [Current scaffold](../src/contexts/memory/entities/memory-fact.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | MemoryService |
| Scaffold fields | `id`; `guildId`; `subjectUserId`; `consentScopeId`; `consentRevision`; `factText`; `sourceProvenance`; `audience`; `contentHash`; `createdAt`; `expiresAt` |
| Relations | many facts -> 1 consent scope (MemoryScope); 1 fact -> 0..N model/content-specific embeddings (FactEmbedding); a fact may be named by deletion progress until content is removed (MemoryDeletionRequest) |
| Lifecycle | Immutable retained content. Corrections create replacements; physical deletion removes content and vectors. Facts can exist without embeddings. |
| Entity methods | None; immutable data or service-coordinated persistence. |
| Plan change | Distinguish consent provenance from the latest privacy fence. Facts survive an optional embedding failure. Corrections/replacements must remove invalid prior content through the owner cleanup path, not just hide it from retrieval. |

### FactEmbedding

Model-specific vector for one exact permitted fact content. **Scope: Staged Memory; optional indexing.** [Current scaffold](../src/contexts/memory/entities/fact-embedding.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | MemoryService |
| Scaffold fields | `id`; `guildId`; `factId`; `embeddingModel`; `modelVersion`; `dimensions`; `contentHash`; `privacyRevision`; `vector`; `createdAt` |
| Relations | One MemoryFact → zero or many model/content-specific vectors. A vector never exists without an eligible fact. Its accepted source result is traceable through task acceptance/audit. |
| Lifecycle | Immutable retained model/content vector; re-embedding creates a new record. Removing a fact removes its vectors. |
| Entity methods | None; immutable data or service-coordinated persistence. |
| Plan change | Optional indexing only. Enforce a unique fact/content/model-version binding with matching dimensions. Validate current privacy and selected model/version when accepting a pending result; retrieval validates current consent and fact existence. Select the initial model in versioned runtime configuration. Semantic query embedding and its workflow are deferred. |

### MemoryDeletionRequest

Retryable progress for removal of personal content copied across managed storage owners. **Scope: Staged Memory.** [Current scaffold](../src/contexts/memory/entities/memory-deletion-request.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | MemoryService |
| Scaffold fields | `id`; `guildId`; `scopeId`; `selectedFactReferences without retained content`; `deletionGeneration`; `storageOwnerProgress`; `requestedAt`; `completedAt`; `revision` |
| Relations | many requests -> 1 scope (MemoryScope); 1 request -> selected 0..N fact identities without content (MemoryFact); 1 request -> required 0..N cleanup acknowledgments (Jobs / Community / Artifact owners) |
| Lifecycle | Mutable per-owner progress until specified managed copies are removed. Eligibility invalidation precedes eventual physical cleanup. |
| Entity methods | `recordOwnerProgress`, `markCompleted` |
| Plan change | Include every required copy owner, including Intake where relevant. Each acknowledgment identifies deletion generation and scope. Completion requires confirmed cleanup/disposition, not merely queue publication; do not retain the erased fact text in progress metadata. |

## Debates

Staged: enable only after the complete task, acceptance, retention and removal paths exist.

### DebateSession

Consented session phase and frozen transcript/rubric/evaluation identity. **Scope: Staged Debates.** [Current scaffold](../src/contexts/debates/entities/debate-session.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | DebateService |
| Scaffold fields | `id`; `guildId`; `channelId`; `topic`; `participants`; `state`; `consentScope`; `transcriptRevision`; `rubricRevision`; `evaluationRequestReference`; `acceptedEvaluationReference`; `cancellationGeneration`; `revision`; `createdAt`; `updatedAt` |
| Relations | 1 session -> 0..N participant consent records during setup (ParticipantConsent); 1 session -> 0..N ordered source entries (TranscriptEntry); 1 session -> 0..N immutable snapshots; one bound current frozen revision (TranscriptSnapshot); many sessions -> 1 bound rubric revision (RubricRevision); 1 session -> 0..N historical evaluations; 0..1 accepted active evaluation reference (DebateEvaluation) |
| Lifecycle | Mutable proposed/active/frozen/evaluated/canceled progress as authorized. Consent and frozen bindings guard transitions. |
| Entity methods | `acceptParticipant`, `start`, `freeze`, `acceptEvaluation`, `cancel` |
| Plan change | Store expected task IDs per evaluation variant under an evaluation request identity. Do not make workflow/stage alone unique. Frozen transcript/rubric and required consent bindings determine eligibility; new evaluation replaces the expected set deliberately. |

### ParticipantConsent

Participant decision on exact debate processing/visibility scope. **Scope: Staged Debates.** [Current scaffold](../src/contexts/debates/entities/participant-consent.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | DebateService |
| Scaffold fields | `id`; `guildId`; `sessionId`; `userId`; `acceptedScope`; `acceptedAt`; `withdrawalState`; `withdrawnAt`; `revision` |
| Relations | One session → zero or many participant decisions during setup; each decision belongs to one verified user and exact session scope. |
| Lifecycle | Accepted scope/time retained; withdrawal state mutable. A changed scope requires renewed explicit consent. |
| Entity methods | `withdraw` |
| Plan change | Unique participant/session decision for the current accepted scope. A proposed session may have zero consent records; starting requires all required current consents. Withdrawal invalidates affected tasks/publication under the declared policy. |

### TranscriptEntry

Ordered attributable source item or explicit edit/deletion/gap marker. **Scope: Staged Debates.** [Current scaffold](../src/contexts/debates/entities/transcript-entry.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | DebateService |
| Scaffold fields | `id`; `guildId`; `sessionId`; `sequence`; `sourceReference`; `authorId`; `sourceRevision`; `retained content or controlled snapshot reference`; `edit/deletion/gap markers`; `sourceTime`; `capturedAt`; `contentHash` |
| Relations | many entries -> 1 session (DebateSession); many ordered entries can appear in multiple revision snapshots (TranscriptSnapshot) |
| Lifecycle | Immutable captured item. Append change markers/revisions rather than overwrite; retention governs eventual content removal. |
| Entity methods | None; immutable data or service-coordinated persistence. |
| Plan change | Add owner retention/removal coverage before enabling the feature. Source updates append new attributable revisions/markers; never silently overwrite a frozen transcript. |

### TranscriptSnapshot

Frozen ordered declared transcript plus hash and coverage. **Scope: Staged Debates.** [Current scaffold](../src/contexts/debates/entities/transcript-snapshot.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | DebateService |
| Scaffold fields | `id`; `guildId`; `sessionId`; `revision`; `orderedEntryReferences`; `contentHash`; `declaredCoverage`; `gaps`; `frozenAt`; `retention/expiry metadata` |
| Relations | many snapshots -> 1 session (DebateSession); 1 snapshot -> ordered 0..N entry references (TranscriptEntry); 1 snapshot -> 0..N bound evaluations (DebateEvaluation) |
| Lifecycle | Immutable retained snapshot; changed scope creates a new snapshot and evaluation binding. |
| Entity methods | None; immutable data or service-coordinated persistence. |
| Plan change | Require a unique (sessionId, revision) within the guild. Snapshot content/hash and declared gaps are fixed. Cleanup must also cover referenced entry content and copied task inputs. |

### RubricRevision

Immutable agreed criteria, weights and outcome configuration for debate scoring. **Scope: Staged Debates.** [Current scaffold](../src/contexts/debates/entities/rubric-revision.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | Proposed DebateService.publishRubricRevision; no current publication method is specified. |
| Scaffold fields | `id`; `guildId`; `rubricId`; `revision`; `criteria`; `weights`; `evaluationConfigurationVersions`; `winningMargin/tie rules`; `createdAt`; `activationTime` |
| Relations | 1 revision -> 0..N sessions (DebateSession); 1 revision -> 0..N evaluations (DebateEvaluation) |
| Lifecycle | Immutable retained revision. Criteria/weights change through a new revision and any necessary renewed consent. |
| Entity methods | None; immutable data or service-coordinated persistence. |
| Plan change | DebateService.publishRubricRevision owns authorized publication. Existing frozen sessions keep their explicitly accepted revision; changes require a new agreed binding where applicable. |

### DebateEvaluation

Accepted criterion evidence, deterministic totals/outcome and distinct publication state. **Scope: Staged Debates.** [Current scaffold](../src/contexts/debates/entities/debate-evaluation.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | DebateService |
| Scaffold fields | `id`; `guildId`; `sessionId`; `transcriptRevision/hash`; `rubricRevision`; `acceptedTaskResultReferences`; `criterionScores`; `evidenceReferences`; `codeComputedTotals`; `uncertainty/tie outcome`; `limitations`; `publicationStatus`; `publicationMessageReference`; `acceptedAt`; `publishedAt`; `revision` |
| Relations | many evaluations -> 1 session (DebateSession); many evaluations -> 1 exact snapshot binding (TranscriptSnapshot); many evaluations -> 1 exact rubric revision (RubricRevision); 1 evaluation -> required accepted result references (TaskResult (Jobs)); 1 result -> 0..1 confirmed publication initially (Discord message) |
| Lifecycle | Accepted score/evidence data immutable; publication status mutable. Changed transcript/rubric requires a new evaluation. |
| Entity methods | `recordPublication`, `recordPublicationUncertainty` |
| Plan change | Add publication destination, intent time, claim generation/lease and bounded attempt/outcome metadata, plus DebateService.recoverPublications. Scores stay immutable while publication advances or is reconciled; no generic publisher is needed. |

## Jobs

### AiTask

One immutable inference request and the authoritative technical execution lifecycle. **Scope: Core.** [Current scaffold](../src/platform/jobs/entities/ai-task.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | TaskService registers/cancels; WorkerTaskStore and TaskRecoveryService perform fenced execution transitions. |
| Scaffold fields | id; guildId; kind; schemaVersion; owner; workflowId; stage; preparedInputId/hash; required revision bindings; provider/model/prompt versions; deadline; lifecycle status; timestamps; row revision; executionGeneration. |
| Relations | One task → one PreparedInput, zero or many TaskAttempt records, zero or one TaskResult before finalization, exactly one result after TERMINAL. Each task belongs to one feature-owned operation. |
| Target lifecycle | READY → RUNNING → RETRY_WAIT as needed; PARKED for unsupported work; TERMINAL is final. Success is a result outcome, not a task state. |
| Entity methods | None; named services coordinate persistence and conditional writes. |
| Plan change | Add explicit owner operationKey, activeAttemptId, attemptCount/maxAttempts, nextAttemptAt, parkReason and terminalResultId. Deduplicate (guild, installation, owner, operationKey, kind, schemaVersion); the owner assigns a new operation revision for deliberate reexecution. Workflow/stage is optional for independent one-shot tasks. Use the single lifecycle in the architecture plan; terminal tasks never reopen. |

### PreparedInput

Minimal immutable task payload with a mutable eligibility and deletion gate. **Scope: Core.** [Current scaffold](../src/platform/jobs/entities/prepared-input.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | TaskService registers/invalidates; WorkerTaskStore releases under a current claim; Jobs cleanup removes payload. |
| Scaffold fields | id; guildId/taskId; payload/schemaVersion; contentHash; controlled artifact refs; source/provenance refs; purpose/audience; scope/revision bindings; expiry; eligibility; disclosure metadata; cleanup state; createdAt. |
| Relations | Exactly one task-bound input; zero or many authorized artifact references. Scope bindings are values, never worker-readable ORM links into contexts. |
| Target lifecycle | Eligible until invalidated/expired. Disclosure is separately recorded and irreversible. Payload may be purged while minimal invalidation metadata survives. |
| Entity methods | None; named services coordinate persistence and conditional writes. |
| Plan change | Index invalidation scopes and make eligible/invalidatedAt explicit. Registration and revocation share owner locks; release checks the input row. Do not add a separate scope-gate entity initially. |

### TaskAttempt

One executor claim and provider execution opportunity, including ambiguous failure. **Scope: Core.** [Current scaffold](../src/platform/jobs/entities/task-attempt.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | WorkerTaskStore; TaskRecoveryService fences expired claims; UsageService owns linked accounting. |
| Scaffold fields | id; guildId/taskId; attemptNumber; generation; executor and lease; claim/start/end times; input-release metadata; provider request ref; retry/failure classification; usage ref; execution state; row revision. |
| Relations | Many attempts → one AiTask. Each provider execution attempt has one reservation binding and zero or one deduplicated UsageEntry. At most one attempt owns current task execution authority. |
| Target lifecycle | Claimed → released/executing → finished or fenced/abandoned. A lost lease does not establish that remote work stopped. |
| Entity methods | None; named services coordinate persistence and conditional writes. |
| Plan change | Make reservationId explicit. Intermediate retryable failure stays here. Unique (taskId, attemptNumber); generation guards writes. Each retry can incur its own charge. |

### TaskResult

One terminal outcome for the logical task, independently of feature acceptance. **Scope: Core.** [Current scaffold](../src/platform/jobs/entities/task-result.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | WorkerTaskStore finalizes executed work; TaskService/TaskRecoveryService finalize cancellation, expiry or unrecoverable failure through the same Jobs transition. |
| Scaffold fields | id; guild/task/attempt identity; generation; output schemaVersion; outcome; validated payload or bounded reason; timing/usage refs; creation and retention metadata. |
| Relations | One AiTask → exactly one terminal result once finalized. attemptId is optional. One result → zero or one TaskAcceptance. |
| Target lifecycle | Immutable once committed while retained. Content deletion does not permit result replacement or another inference run. |
| Entity methods | None; named services coordinate persistence and conditional writes. |
| Plan change | Replace current per-attempt uniqueness with unique taskId. Outcomes: success, uncertain, failure, canceled, expired. attemptId may be null. Result + task finalization + completion outbox commit together. Add payloadUnavailable/purgeReason and pending discard metadata for erasure before owner acknowledgment; a later consumer must discard, never accept an empty success or repeat inference. |

### TaskAcceptance

The feature owner acknowledgment of a terminal task outcome. **Scope: Core.** [Current scaffold](../src/platform/jobs/entities/task-acceptance.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | Feature acceptance method supplies the decision; TaskService.recordAcceptance persists it in the same local transaction. |
| Scaffold fields | id; guild/task/result identity; owner/workflow/stage; expected task and relevant revision/generation binding; status; reason; timestamp. |
| Relations | Zero or one acknowledgment per terminal result. Different expected tasks may legitimately share a workflow/stage. One-shot operations use their exact operation key and validity binding instead of a workflow expected-task slot. |
| Target lifecycle | Immutable accepted or discarded receipt. Accepted means processed by the owner, including handling failure; it is not permission to act. |
| Entity methods | None; named services coordinate persistence and conditional writes. |
| Plan change | Use unique resultId and accepted/discarded terminology. Obsolete results are discarded with a reason. A temporarily unavailable owner leaves the result unacknowledged and completion visibly parked. |

### OutboxEntry

Durable publication intent created with the state change it announces. **Scope: Core.** [Current scaffold](../src/platform/jobs/entities/outbox-entry.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | Calling owner creates through Jobs inside its transaction; OutboxRelay claims/publishes; recovery redrives. |
| Scaffold fields | messageId; guildId when applicable; versioned topic/kind; aggregate/task ref; createdAt; publication status; claim/attempt metadata; publishedAt; nextAttemptAt; bounded error classification. |
| Relations | References an owning intake/task/result/cleanup/operation record. One publication may be delivered multiple times; consumer receipts establish actual acceptance. |
| Target lifecycle | Pending → claimed → published, with bounded retry or explicit park metadata. Publication acknowledgment is not consumer completion. |
| Entity methods | None; named services coordinate persistence and conditional writes. |
| Plan change | Persist explicit completion-routing incompatibility/park reason on delivery metadata. Recovery uses missing TaskAcceptance to redeliver the stored result; it never reopens inference. |

## Usage

### UsageReservation

Bounded budget capacity held for a planned attempt or explicit feature operation. **Scope: Core.** [Current scaffold](../src/platform/usage/entities/usage-reservation.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | UsageService.reserve, settleAttempt, markUncertainCost and releaseUnusedReservation. |
| Scaffold fields | id; guildId; provider/feature; task/attempt or operation ref; reserved amount/units; policy revision/spend window; expiry; settlement state; timestamps; row revision; accounting refs. |
| Relations | A task may have multiple reservations across attempts. The first is reserved at registration and attached at claim; each retry requires a distinct reservation. Many reservations use one policy revision snapshot. |
| Target lifecycle | Reserved → settled, released-unused or unresolved liability. Expiry alone cannot release possibly spent capacity. |
| Entity methods | None; named services coordinate persistence and conditional writes. |
| Plan change | Give pre-claim reservation a unique task/attempt-slot identity and nullable attemptId until claimed. Recover unused reservations and reconcile unknown ones. Do not release already billed/possibly billed spend because a result was discarded. |

### UsageEntry

Known actual usage or unresolved estimated liability for one provider attempt. **Scope: Core.** [Current scaffold](../src/platform/usage/entities/usage-entry.entity.ts).

| Item | Reference |
| --- | --- |
| Writer | UsageService; late usage evidence remains writable through the restricted attempt accounting operation. |
| Scaffold fields | id; guildId; provider; attempt/operation and reservation refs; provider request ref; actual or estimated cost; units; accounting state; evidence/timestamps; reconciliation metadata; row revision. |
| Relations | One deduplicated entry per provider attempt/explicit billable operation. Separate retries remain separate entries even if the logical task is the same. |
| Target lifecycle | Unresolved estimate → known actual/no-spend evidence. Actual usage is never overwritten by a later timeout; corrections retain traceable evidence. |
| Entity methods | None; named services coordinate persistence and conditional writes. |
| Plan change | Keep cost acceptance independent of task-result generation checks. Account for late/stale workers without restoring discarded output. Store references and units, not prompts. |

## Proposed additions

These four records close concrete durability gaps. Their source files have not been created. Intake belongs to the bot ingestion boundary; artifact and audit persistence extend the existing adapters.

### IntakeEvent

The durable, bounded record of input before feature branching. **New proposal — Bot ingress.**

| Item | Reference |
| --- | --- |
| Writer | Proposed IntakeService, called after Discord normalization. |
| Proposed fields | id; guildId; installationGeneration; eventKind; sourceEventKey; stable sourceKey; source/channel/actor IDs; source revision/time; current-source marker/deletion tombstone and validity state; ingressSequence; acceptedAt; snapshot schemaVersion; bounded snapshot/artifact refs; contentHash; missing coverage; retention and cleanup metadata. |
| Relations | One event → one IntakeDelivery per intended consumer; initially Moderation and potentially eligible Community. Feature records preserve the originating intake reference. |
| Lifecycle | Capture/commit → retained until required owner receipts finish and data is copied as needed → payload purged → bounded dedup metadata expiry. |
| Rules | Unique (guildId, installationGeneration, sourceEventKey). Event + recipients + wake-up outbox are atomic. At most one latest-observed marker per source; update/read under the same source-key gate used by owner registration/acceptance. Use source revision evidence, not greatest ingress sequence, to choose currentness; unresolved ordering blocks dependent work. Newer/unresolved source state invalidates affected inputs. Retain minimal marker/tombstone metadata through outstanding work and replay, independently of payload retention. This commit is the restart-recovery boundary. |

### IntakeDelivery

Independent acknowledgment that one feature durably handled an event. **New proposal — Bot ingress.**

| Item | Reference |
| --- | --- |
| Writer | Proposed IntakeService coordinates claims; feature admission and receipt completion share one transaction. |
| Proposed fields | id; guildId; eventId; owner; orderKey; state; claim generation/lease; attempt count; nextAttemptAt; processingDeadline where applicable; receipt outcome; owner record ref; completion time; bounded error/park reason. |
| Relations | Many deliveries → one IntakeEvent. Unique (eventId, owner). Receipt may point to a case/request or record ignored/expired without creating a feature record. |
| Lifecycle | READY → RUNNING → DONE; RETRY_WAIT or PARKED on processing interruption. Terminal receipt outcome records handled/ignored/expired/failed as appropriate. |
| Rules | Receipt completion is feature admission, not AI completion. Community deadline starts at intake. Moderation failure is visible and does not silently inherit reply expiry. No separate IntakeAttempt entity is needed. |

### ArtifactRecord

Metadata that makes uploaded bytes attributable, authorized and recoverably deletable. **New proposal — Artifacts.**

| Item | Reference |
| --- | --- |
| Writer | ArtifactStore under owner-issued access/retention bindings. |
| Proposed fields | id; guildId; owner and owner-record/retention-scope ref; known storage key; state; createdAt; upload deadline; verified hash/type/size; purpose/access binding; expiry; deletion request/progress; retry/error metadata. |
| Relations | One record → zero or one intended stored object within one owner's retention scope. Independently retained copies get separate records/objects. Controlled references cannot extend this scope's expiry. Access never comes from knowing the key alone. |
| Lifecycle | PENDING → READY → DELETING → DELETED; abandoned upload can go directly from PENDING to DELETING. Non-ready content is unreadable. |
| Rules | Persist before upload; finalize conditionally. The owning retention scope determines expiry/deletion and invalidates affected uses first. Do not share one object across independently retained contexts or introduce implicit reference counting. Bound late uploads and sweep or expire them after cancellation; no untracked permanent object. |

### AuditEntry

Bounded trusted history of local changes and observed external outcomes. **New proposal — Audit.**

| Item | Reference |
| --- | --- |
| Writer | AuditRecorder.recordTransition / recordExecutionOutcome inside the caller transaction. |
| Proposed fields | id; schemaVersion; guildId; timestamp; authenticated actor or policy origin; operation; owner/entity/revision refs; observed outcome; correlation/idempotency key; retention metadata. |
| Relations | Many entries may describe one workflow, action or attempt. References do not transfer business ownership or require retaining raw content forever. |
| Lifecycle | Append-only factual record while retained; bounded owner-approved expiry/redaction. A new observation appends evidence rather than changing business state. |
| Rules | No full prompts, evidence or transcripts by default. Do not label an attempted/unknown Discord operation successful. Audit is neither an authority grant nor the application state machine. |

## Contracts are not entity tables

These values move between boundaries; they do not each need a table or class hierarchy. Persist them only as a bounded, versioned snapshot inside the appropriate owner record.

Concrete feature request/response shapes now live in each context's `dto/` directory. `contracts.ts` retains trusted authorization/provenance bindings and shared domain values. Each DTO's fields, producer/consumer and validation rules are described in its comment-only file; the [DTO lookup](DTO_REFERENCE.md) maps those files to services. This distinction does not change the entity inventory above.

| Value family | Purpose | Current location / target decision |
| --- | --- | --- |
| ObservationInput / ObservationResult | Captured source and requested coverage → supported observations and explicit gaps | [Observation contracts](../src/ai/contracts/observation.contracts.ts) |
| AssessmentInput / AssessmentResult | Owner-selected criteria/questions → typed evidence-linked answers | [Assessment contracts](../src/ai/contracts/assessment.contracts.ts) |
| ReplyGenerationInput / ReplyGenerationResult | Authorized context and audience → bounded generated reply | [Generation contracts](../src/ai/contracts/generation.contracts.ts); defer its unowned explanation variant |
| FactProposalInput / FactProposalResult | Consented attributable source → bounded candidate facts with provenance | Proposed explicit contract when automated Memory extraction ships |
| EmbeddingInput / EmbeddingResult | Authorized exact text → model-specific numeric vectors | [Embedding contracts](../src/ai/contracts/embedding.contracts.ts); optional fact indexing |
| Capability outcome / ProviderUsage | Validated success, uncertainty, categorized failure and usage evidence | [Technical outcome vocabulary](../src/ai/contracts/capability-result.contracts.ts); Jobs adds canceled/expired task outcomes |
| Authority, safety and disclosure bindings | Trusted scoped values checked against current owner state | Context public contracts; never authority supplied by model output |
| NormalizedDiscordMessageDto / NormalizedInteractionDto | Verified transport metadata and bounded untrusted content/arguments | [Discord DTOs](../src/discord/dto/normalized-message.dto.ts); selected message snapshot becomes IntakeEvent |
| InteractionContextDto / TrustedCallerContext | Verified transport identity followed by a service-facing caller value with installation binding | [Transport context](../src/discord/dto/interaction-context.dto.ts) and [Administration contracts](../src/contexts/administration/contracts.ts); neither grants authority |
| TaskSignalDto | Versioned queue wake-up containing a task reference | [Jobs notification DTO](../src/platform/jobs/dto/task-signal.dto.ts); actual owner/result come from stored state |

An **artifact** is retained bytes such as a captured attachment; ArtifactRecord stores its metadata and lifecycle. An **embedding** is a numeric representation used for similarity; FactEmbedding stores a vector tied to exact fact content and model. Neither is a replacement for the underlying business record.

## What is deliberately absent

No generic base entity/repository, universal workflow record, separate registry service, custom transaction wrapper, generic cleanup-job entity or scope-gate record is required by this plan. Static registration and existing owner locks are sufficient initially. No source schema is added solely to reserve a possible future feature.

Before enabling optional semantic search, design its query-embedding request/result/continuation explicitly. The catalog intentionally does not pretend that storing FactEmbedding alone completes that feature.
