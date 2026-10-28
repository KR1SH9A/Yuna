# Remaining scaffold audit and implementation plan

29 October 2026. Audited all TypeScript in src/ and apps/ using the TypeScript parser, then traced imports, callers, owner services and nearest tests. The starting tree contained **31 comment-only files**, including 10 under contexts. A design comment is not an implementation. No TODO/NotImplemented throwing method bodies were found; the explicit fake lifecycle resource is development-only.

## Plan

- [x] Inventory every empty file and trace the intended behavior to its actual owner.
- [x] Implement shared current-state reads and missing bounded ban lookup; preserve incomplete/unknown outcomes.
- [x] Implement and consume reply policy, actual DTOs, exact worker routes and bot completion/recovery composition.
- [x] Connect staff kicks through command registration data, ingress validation and the existing authorized owner.
- [x] Remove 20 unused design-only files whose behavior already has an owner or whose proposed architecture was superseded. This does not remove runtime code.
- [x] Reject comment-only production TypeScript in the documentation check.
- [x] Run focused regressions, the full isolated PostgreSQL suite, documentation and diff checks.

## Eleven files now contain consumed implementation or contracts

| File | Implementation |
| --- | --- |
| [src/discord/state-reader.ts](../src/discord/state-reader.ts) | Executable readExecutionFacts, readMessage, readBan and readRelevantAuditEntries. Gateway authority/source reads and moderation audit reconciliation use it. |
| [src/contexts/community/reply.policy.ts](../src/contexts/community/reply.policy.ts) | Executable eligibility, audience and generated-reply checks consumed at admission, acceptance and dispatch. Reject invalid dates and changed destination/audience/mentions. |
| [src/contexts/community/contracts.ts](../src/contexts/community/contracts.ts) | Moved actual audience, provenance, continuation and destination definitions from entity files; entities use the shared definitions. |
| [src/contexts/community/dto/conversation.dto.ts](../src/contexts/community/dto/conversation.dto.ts) | Actual admission and channel/status views used by ConversationService, without speculative attachment/status operations. |
| [src/contexts/community/dto/reply-delivery.dto.ts](../src/contexts/community/dto/reply-delivery.dto.ts) | Actual delivery states, dispatch claims, attempt metadata and observed outcomes used by ReplyDelivery. |
| [src/discord/dto/interaction-context.dto.ts](../src/discord/dto/interaction-context.dto.ts) | Actual authenticated command identity and bounded private response contract. |
| [src/discord/dto/normalized-interaction.dto.ts](../src/discord/dto/normalized-interaction.dto.ts) | Actual normalized command union and capability choices, including the connected kick command. |
| [src/discord/dto/normalized-message.dto.ts](../src/discord/dto/normalized-message.dto.ts) | Actual message reference, normalized conversation input and original-capture provenance contracts. |
| [apps/ai-worker/task.registry.ts](../apps/ai-worker/task.registry.ts) | Exact kind/version resolution and fair scanning for the four supported routes; worker lanes consume the registry. |
| [apps/bot/completion.handlers.ts](../apps/bot/completion.handlers.ts) | Independent stored-result acceptance loops for Community, Moderation and Debates extracted from bot composition. |
| [apps/bot/recovery.handlers.ts](../apps/bot/recovery.handlers.ts) | Independent task/effect recovery, reconciliation and owner retention loops extracted from bot composition. |

## Twenty obsolete files retired

These are consolidations, not twenty new services. The source history retains the original design comments; the live ownership is recorded here. Adding wrapper classes would split transaction/effect ownership and leave the real code unchanged.

| Retired file | Existing implementation / reason |
| --- | --- |
| `src/discord/actions.ts` | DiscordGateway.sendReply/interaction callbacks, DiscordModerationTransport.execute and DiscordDebateTransport retain separate effect protocols. |
| `src/ai/contracts/capability-result.contracts.ts` | generation, observation and assessment contracts define separate validated payloads; no universal optional-field result envelope. |
| `src/ai/jev/jev.module.ts` | createWorkerResources constructs JevService with explicit runtime configuration. |
| `src/ai/llm/llm.module.ts` | createWorkerResources constructs LlmService with explicit runtime configuration. |
| `src/contexts/administration/administration.module.ts` | createBotResources composes authority, safety, configuration, lifecycle and removal with their actual collaborators. |
| `src/contexts/community/community.module.ts` | createBotResources connects ConversationService, KnowledgeService and ReplyDeliveryService, including invalidation callbacks. |
| `src/contexts/debates/debates.module.ts` | createBotResources composes DebateService and publication; createWorkerResources registers DebateTaskHandlers. |
| `src/contexts/moderation/ban.service.ts` | StaffModerationService.requestBan/requestUnban and ActionExecutionService own preparation, dispatch, outcome, reconciliation and recovery. |
| `src/contexts/moderation/kick.service.ts` | StaffModerationService.requestKick and ActionExecutionService share the target gate and effect protocol; /yuna kick now reaches them. |
| `src/contexts/moderation/warning.service.ts` | ModerationWorkflowService prepares warning intents; ActionExecutionService owns dispatch, outcome, reconciliation and recovery. |
| `src/platform/audit/audit.module.ts` | AuditRecorder is composed directly by owner services and the bot. |
| `src/platform/audit/contracts.ts` | AuditEntryInput, AuditOrigin and AuditReference in audit-entry.entity.ts plus AuditRecorder validators define the actual bounded audit contract. |
| `src/platform/db/transaction-context.ts` | Each public owner already uses orm.em.fork().transactional; supplied EntityManager values preserve caller transactions. No ambient transaction wrapper. |
| `src/platform/jobs/contracts.ts` | conversation-task.contracts.ts, moderation-task.contracts.ts and debate-task.contracts.ts define exact route/version and stored-result bindings. |
| `src/platform/jobs/jobs.module.ts` | Bot/worker roots explicitly construct TaskService and the restricted task stores. |
| `src/platform/jobs/outbox.relay.ts` | PostgreSQL commit-only NOTIFY and createTaskWakeup shorten durable scans. There is no external broker publication to claim or acknowledge. |
| `src/platform/jobs/task-recovery.service.ts` | TaskService.recoverExpired, ModerationTaskService.recoverExpired and DebateTaskService.recover run restricted recovery; owner completion scans revisit unaccepted results. Durable scans replace missing notifications. |
| `src/platform/usage/contracts.ts` | Usage entity value contracts and UserUsageService public views own exact decimal accounting and personal quotas. |
| `src/platform/usage/usage.module.ts` | UsageService and UserUsageService are explicitly composed where reservations and member preferences are used. |
| `src/platform/jobs/dto/task-signal.dto.ts` | Wakeups contain no workflow authority or result payload. createTaskWakeup ignores payloads and owners scan stored scope; no signal DTO is needed. |

## Product work this does not silently enable

The empty-file audit is separate from delivering every feature in the architecture proposal. Proactive replies still fail closed and cannot be configured; release needs explicit relevance/cooldown policy and admission coverage. Governance services still need additive production schema, custodian provisioning and operator commands. Artifact storage needs a configured storage/authorization composition and an admitted media workflow. Embedding calls need a durable worker route, FactEmbedding deployment and privacy-bound retrieval. Inferred memory, media-content moderation and coordinated raid/spam detection are not released. Interaction continuation records do not by themselves make generated interaction replies a live flow. These require feature work, not empty wrappers.

Local tests use fake Discord/provider boundaries. An operator must register the updated guild commands and run live Discord/provider acceptance; this change makes no external registration, migration or deployment.

## Read adapter contract references

The implementation follows Discord’s [message read](https://docs.discord.com/developers/resources/message#get-channel-message), [ban lookup](https://docs.discord.com/developers/resources/guild#get-guild-ban), [error codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes#json) and [bounded audit log](https://docs.discord.com/developers/resources/audit-log#get-guild-audit-log) contracts. Only an exact Unknown Message/Unknown Ban error establishes absence. A current ban does not attribute a prior effect. An empty audit page remains inconclusive.

## Verification

- `npm test`: 390 tests in 41 suites passed.
- `npm run test:all`: 605 tests in 63 suites passed, including isolated PostgreSQL integration tests.
- `npm run typecheck`, `npm run check:docs` and `git diff --check`: passed.
- TypeScript AST scan: zero comment-only production files remain; all twenty deletions contained no statements.
- Regression coverage includes ban/message absence versus access failure, restricted content, availability epochs, exact audit attribution, internal request IDs, worker fairness/version rejection, kick ingress and owner routing, and persisted reply binding/mention changes blocking dispatch.
