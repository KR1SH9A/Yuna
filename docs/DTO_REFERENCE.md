# Yuna DTO and module reference

Yuna keeps request/response shapes next to the feature that owns the operation. This reference maps the comment-only DTO files to their services and explains validation, trusted identity, module exports and persistence ownership. The [entity model plan](DATA_MODEL_REFERENCE.md) is authoritative for target stored records and their ownership; the [architecture plan](ARCHITECTURE_PLAN.md) covers durable execution and recovery.

These files describe the design. They do not declare executable DTO classes, validators, NestJS providers or database models yet. Memory, Debates and optional governance remain staged.

## Find the right file

| Location | Contains | Typical change |
| --- | --- | --- |
| Feature `dto/` | Concrete operation arguments and serialized responses | Add a report field or change the permitted case view |
| Feature `contracts.ts` | Trusted bindings and shared domain values | Refine evidence identity, audience binding or authorization values |
| Feature services | Application operations, transactions and workflow progression | Change how a report becomes a case |
| Feature policies | Rules evaluated from supplied values | Change an eligibility rule without adding I/O |
| Feature `entities/` | Private persisted records and local transitions | Add a stored revision or outcome field |
| Feature module | Providers, private entity registration and explicit exports | Make an existing service available to bot recovery |
| `apps/bot` handlers | Discord, completion and recovery entry points | Validate an interaction and route it to an operation |
| `src/discord/dto` | Normalized transport events and verified invocation metadata | Handle a partial Discord message consistently |
| `src/platform/jobs/dto` | Queue notification envelopes | Validate a wake-up reference before loading its task |
| `src/ai/contracts` | Versioned capability inputs/results and runtime schema specifications | Add an observation field or validate a provider result |

For example, the Moderation feature keeps a shallow structure:

```text
src/contexts/moderation/
  moderation.module.ts           # Registers private records and exports named services
  moderation.service.ts          # Intake, original capture coverage and AI result acceptance
  staff-moderation.service.ts     # Authenticated ban, unban and optional kick requests
  moderation.policy.ts           # Pure decision rules
  ban.service.ts                 # Ban/unban intent, dispatch and recovery
  warning.service.ts             # Warning intent, dispatch and recovery
  kick.service.ts                # Optional explicit kick operations
  contracts.ts                   # EvidenceBinding and Disposition values
  dto/
    moderation-intake.dto.ts      # Message/report/revision arguments and case response
    staff-sanction.dto.ts         # Exact staff request arguments and acceptance response
    action-outcome.dto.ts         # Effect and recovery responses
  entities/                      # Private case, evidence, finding, policy and effect records
```

Related shapes share one use-case file. A DTO is not required for every entity or helper argument. Names such as `Dto`, `RequestDto` and `ResponseDto` identify transferred data; they do not prescribe a class hierarchy. Keep the current `contexts/` directory: each context already acts as a feature module, so a directory rename adds no necessary boundary.

## Identity, input and authorization

For a staff ban, the handler validates `BanRequestDto` containing the exact target and supported reason/options. It obtains the actor and guild from verified transport metadata, calls `GuildLifecycleService.readInstallation` and passes `TrustedCallerContext` separately to `StaffModerationService.requestBan`. The service checks current Yuna authority, native permissions and target eligibility before producing durable action intent. Its response can confirm acceptance without claiming the Discord ban has already succeeded.

| Value | Created by | Meaning |
| --- | --- | --- |
| `InteractionContextDto` | Discord normalizer from authenticated transport metadata | Who invoked the interaction and where it came from |
| `SourceProvenance` | Discord normalizer from observed source metadata | Message identity, attributable author/revision and capture provenance, including explicitly missing attribution |
| Feature request DTO | Handler validation of allowlisted command arguments | What operation arguments were supplied |
| `TrustedCallerContext` | Bot entry point using verified identity and owner-loaded installation state | Transport-neutral actor, guild, immutable installation ID/generation and source request identity |
| `StaffRequestAuthority` or `PolicyAuthority` | Administration authorization operations using current facts | The precise authority relevant to the operation |
| Feature response DTO | Owning service after access filtering | The permitted serialized result/progress view |

`TrustedCallerContext` is defined once in [Administration contracts](../src/contexts/administration/contracts.ts). It records provenance, not permission. User arguments cannot override its actor, guild or installation identity fields. A requested target ID is valid input but still requires scope/access checks. Automatic moderation and scheduled recovery use their explicit system-policy or stored-operation bindings; they do not impersonate a human caller.

Normalized message DTOs include both trusted source metadata and untrusted content, marked separately. Ingress maps those into the feature's argument DTO and trusted source values. Features do not import the bot application or Discord SDK objects. A claimed author inside message text is never trusted source metadata.

## Validation and serialization

| Boundary | What to validate | What remains with the service |
| --- | --- | --- |
| Discord event normalization | IDs as strings, supported event shape, bounded content, explicit missing fields | Current installation, attribution-dependent eligibility and permissions |
| Feature operation arguments | Required fields, known variants, lengths/counts, reference syntax and expected revision shape | Current revision equality, same-guild ownership, authority and policy |
| Queue notification | Supported envelope version and task-reference shape | Claim eligibility, stored ownership, deadline and disclosure permission |
| Prepared AI input / provider output | Exact capability schema/version, limits and required result structure | Business interpretation, expected operation, current evidence/privacy and action authorization |
| Public response | Allowlisted fields, bounded content and coherent status/outcome | Which audience may receive those fields |

Wire validation into Discord handlers and queue consumers explicitly. An HTTP validation pipeline is not the specification for these entry points. TypeScript annotations and DTO filenames provide no runtime checks on their own. Select a validation library when runtime dependencies are chosen, keeping one authoritative schema/validation definition for each boundary shape.

Never spread raw command options into trusted context or serialize an ORM entity directly. Reject unexpected identity/authority fields. Revalidate retained serialized input at its versioned boundary. Provider-schema success does not make a finding correct or authorize a sanction.

## DTO lookup

The files below contain fields, producer/consumer responsibilities and validation notes. Directions are relative to the owning feature or adapter; internal effect/recovery responses are identified explicitly.

### Moderation

| File | DTOs | Service operations and direction |
| --- | --- | --- |
| [moderation-intake.dto.ts](../src/contexts/moderation/dto/moderation-intake.dto.ts) | `IngestMessageDto`, `ReportMessageDto`, `CompleteOriginalCaptureDto`, `ModerationCaseDto` | Arguments into `ModerationService.ingestMessage`, `ingestReport`, `completeOriginalCapture`; authorized case/progress out of human operations and small internal dispositions out of acceptance. Original source identity remains separate. Capture completion may improve the same original; edits/deletion do not become replacement evidence. Internal acceptance returns a small continuation outcome; human-facing case views require an authorized projection. |
| [staff-sanction.dto.ts](../src/contexts/moderation/dto/staff-sanction.dto.ts) | `BanRequestDto`, `UnbanRequestDto`, optional `KickRequestDto`, `StaffSanctionResultDto` | Arguments into `StaffModerationService.requestBan`, `requestUnban`, optional `requestKick`; authorized acceptance/denial out. |
| [action-outcome.dto.ts](../src/contexts/moderation/dto/action-outcome.dto.ts) | `ModerationActionOutcomeDto`, `ModerationRecoveryResultDto` | Internal bounded responses from `BanService`, `WarningService` and optional `KickService` dispatch/reconciliation/recovery. No arbitrary public execution request. |

### Community

| File | DTOs | Service operations and direction |
| --- | --- | --- |
| [conversation.dto.ts](../src/contexts/community/dto/conversation.dto.ts) | `ConversationInputDto`, `CancelConversationDto`, `ConversationResultDto` | Arguments into `ConversationService.receiveInput` / `cancelRequest`; permitted progress out of admission and `getConversationStatus`; internal acceptance returns applied/discarded/alreadyHandled. |
| [knowledge.dto.ts](../src/contexts/community/dto/knowledge.dto.ts) | `ApproveKnowledgeEntryDto`, `ChangeKnowledgeVisibilityDto`, `RetireKnowledgeEntryDto`, `VisibleKnowledgeQueryDto`, `KnowledgeEntryDto` | Arguments into `KnowledgeService.approveEntry`, `changeVisibility`, `retireEntry`, `findVisibleEntries`; scoped entry views out. Automatic lookup uses verified source/installation/audience values; human operations also carry `TrustedCallerContext`. |
| [reply-delivery.dto.ts](../src/contexts/community/dto/reply-delivery.dto.ts) | `ReplyDeliveryOutcomeDto`, `ReplyRecoveryResultDto` | Internal bounded publication/recovery responses from `ReplyDeliveryService`; confirmed and unknown delivery remain distinct. |

### Administration

| File | DTOs | Service operations and direction |
| --- | --- | --- |
| [grant-revocation.dto.ts](../src/contexts/administration/dto/grant-revocation.dto.ts) | `RevokeGrantRequestDto`, `GrantRevocationResponseDto` | Arguments into `AuthorityService.revokeGrant`; resulting revocation/revision view out. |
| [guild-safety.dto.ts](../src/contexts/administration/dto/guild-safety.dto.ts) | `PauseGuildRequestDto`, `ResumeGuildRequestDto`, `GuildSafetyResponseDto` | Arguments into `SafetyService.pauseGuild` / `resumeGuild`; minimal safety display snapshot out. Internal `SafetyGate` remains a separate concurrency binding. |
| [governance.dto.ts](../src/contexts/administration/dto/governance.dto.ts) — optional | `ProposePlanRequestDto`, `ApprovePlanRequestDto`, `EnrollCustodianRequestDto`, `GovernancePlanResponseDto`, `CustodianEnrollmentResponseDto` | Existing optional `GovernanceService.proposePlan`, `approvePlan`, `enrollCustodian` interaction inputs/outputs. Approval evidence and candidate acceptance are independently verified. |

### Memory — staged

| File | DTOs | Service operations and direction |
| --- | --- | --- |
| [memory-consent.dto.ts](../src/contexts/memory/dto/memory-consent.dto.ts) | `SetMemoryConsentRequestDto`, `MemoryConsentResponseDto` | Arguments into `MemoryService.setConsent`; effective consent display values out. A display response is not a disclosure authorization. |
| [inspect-memory.dto.ts](../src/contexts/memory/dto/inspect-memory.dto.ts) | `OwnMemoryFactsResponseDto` | Private response from `inspectOwnFacts`; verified owner and selected guild are supplied separately, so there is no empty request DTO. |
| [forget-memory.dto.ts](../src/contexts/memory/dto/forget-memory.dto.ts) | `ForgetMemoryRequestDto`, `MemoryDeletionResponseDto` | Arguments into `forget`; deletion identity and current cleanup progress out, without copied deleted content. |

### Debates — staged

| File | DTOs | Service operations and direction |
| --- | --- | --- |
| [debate-session.dto.ts](../src/contexts/debates/dto/debate-session.dto.ts) | `ProposeDebateSessionRequestDto`, `RecordDebateConsentRequestDto`, `CancelDebateSessionRequestDto`, `DebateSessionResponseDto` | Arguments into `DebateService.proposeSession`, `recordConsent`, `cancelSession`; authorized session/scope/progress view out. |
| [debate-result.dto.ts](../src/contexts/debates/dto/debate-result.dto.ts) | `DebateResultResponseDto` | Authorized result view from the `publishResult` flow. Scoring input remains stored AI results and the internal frozen evaluation binding. |

### Discord and Jobs

| File | DTO | Producer → consumer |
| --- | --- | --- |
| [normalized-message.dto.ts](../src/discord/dto/normalized-message.dto.ts) | `NormalizedDiscordMessageDto` | `DiscordInputNormalizer.normalizeMessage` / `normalizeMessageRevision` → bot durable intake and owner routing |
| [interaction-context.dto.ts](../src/discord/dto/interaction-context.dto.ts) | `InteractionContextDto` | Verified transport → bot caller-context preparation, separate from operation arguments |
| [normalized-interaction.dto.ts](../src/discord/dto/normalized-interaction.dto.ts) | `NormalizedInteractionDto` | `DiscordInputNormalizer.normalizeInteraction` → `DiscordHandlers.onInteraction` → known feature argument validation |
| [task-signal.dto.ts](../src/platform/jobs/dto/task-signal.dto.ts) | `TaskSignalDto` | `OutboxRelay` → worker execution handlers or bot `CompletionHandlers`; actual metadata/result is loaded from Jobs |

Local write methods join/create short transactions without external I/O. Dispatch/reconciliation orchestrators enter outside an active transaction. Authorized owner reads are added for concrete staff/status workflows; internal completion outcomes are not human-facing views.

The configuration writers proposed in the architecture plan, such as policy publication and channel-setting mutation, still require their complete operation contracts when added to the scaffold. This organizational change makes already-described use cases visible; it does not silently add those operations or activate staged features.

ID-only task signals resolve through `TaskService.readTaskDescriptor` in the bot and `WorkerTaskStore.readTaskDescriptor` in the worker. This minimal stored routing view lets consumers select a known owner/handler without querying private tables, reading payloads or creating an attempt merely to discover compatibility. Claims, disclosure and result acceptance still use their separate gates.

## Public module providers

These are planned dependency-injection exports. Importing a DTO/type is separate from injecting a service. Bot composition must not re-register a private provider to bypass a missing module export.

| Module | Public provider exports | Private implementation |
| --- | --- | --- |
| [ModerationModule](../src/contexts/moderation/moderation.module.ts) | `ModerationService`, `StaffModerationService`, `BanService`, `WarningService`; optional `KickService` | Policies, seven entity registrations and owner-controlled persistence queries |
| [CommunityModule](../src/contexts/community/community.module.ts) | `ConversationService`, `KnowledgeService`, `ReplyDeliveryService` | Reply policy, four entity registrations and owner-controlled persistence queries |
| [AdministrationModule](../src/contexts/administration/administration.module.ts) | `AuthorityService`, `SafetyService`, `GuildLifecycleService`; optional `GovernanceService` | Authority policy, baseline/optional entity registrations and persistence |
| [MemoryModule](../src/contexts/memory/memory.module.ts) — staged | `MemoryService` | Consent/storage policy, four entity registrations and persistence |
| [DebatesModule](../src/contexts/debates/debates.module.ts) — staged | `DebateService` | Scoring policy, six entity registrations and persistence |
| [DiscordModule](../src/discord/discord.module.ts) | `DiscordInputNormalizer`, `DiscordStateReader`, `DiscordActions` | SDK client/connection and transport mapping |
| [JobsModule](../src/platform/jobs/jobs.module.ts) | Bot role: `TaskService`, `TaskRecoveryService`, `OutboxRelay`; worker role: restricted `WorkerTaskStore` | Jobs records, persistence and credentials restricted for each role |

Effect services are exported because the bot dispatch/recovery handlers consume their operations. Their methods still enforce current owner gates; an export is not permission to perform an unchecked effect. AI provider modules remain worker-only, and the static task lookup is not an injectable registry service.

## Persistence without extra layers

Feature modules register their own entities. Their services coordinate native ORM repositories/query APIs within the caller's fresh context and short transaction. Policies receive values, handlers call public services, and other contexts use the owning service API. The shared database module configures infrastructure; it does not become a central catalog of business repositories.

Create a named feature-owned repository when repeated or complex queries deserve a reusable home—for example, a nontrivial due-action selection used by multiple operations. Give it query/persistence responsibilities, not provider calls, authorization decisions or its own nested commits. There is no custom repository per entity and no generic base repository in this change.

Workflow and attempt records remain separate where their lifecycles differ. Introducing DTOs does not merge them, change task ownership or move synchronous provider calls into the bot. Durable input processing and the AI worker boundary remain as specified in the architecture plan.
