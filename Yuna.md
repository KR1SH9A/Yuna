# Yuna implementation guide

Updated 29 October 2026. This is the function, data-flow and implementation guide requested in [considerations.txt](considerations.txt). Read [local setup](docs/LOCAL_TEST.md), [configuration](config/README.md) and [operations](docs/OPERATIONS.md) for running an installation.

## Scope and current state

The selected implementation now includes conversations, approved server knowledge, automatic text moderation with setup-time server guidance import, optional staff ban/unban/kick controls, member quotas and spending preferences, explicit private memory, and consented structured debates. Administration owns authority, configuration, safety and removal. PostgreSQL owns durable claims and accounting; separate bot and worker processes own Discord and provider I/O respectively.

The user authorized completing the remaining implementation, adding missing behavior where existing functions could not provide it, supplying editable defaults, and documenting files and methods. Existing notification and latency changes were preserved. No commit or push is part of this work.

There are 40 entity mappings: 36 enabled and four staged. Ten versioned migrations deploy the enabled schema and restricted worker functions. The personal usage preference table is SQL-owned rather than an ORM entity. Staged mappings are ActionPlan, PlanApproval, CustodianEnrollment and FactEmbedding. Their presence does not enable governance or semantic search.

This is ordinary TypeScript composition with MikroORM transactions and PostgreSQL notifications plus fallback scans. It does not require a web server, Redis or a second queue system. One bot owns one configured guild; workers share a bounded concurrency limit across enabled task routes. Provider policy is model-selectable, while the current adapters implement DeepSeek chat and OpenRouter Decisions protocols.

## Remaining scaffold completion, 29 October

The [implementation audit](docs/IMPLEMENTATION_AUDIT.md) accounts for all 31 formerly comment-only TypeScript files: eleven now contain consumed code/contracts; twenty unused designs were retired in favor of their existing owners. `check:docs` rejects empty production files, including empty export placeholders. This resolves the misleading source scaffolds; it does not claim every proposed product feature is released.

`DiscordStateReader.readExecutionFacts` now owns native permission and hierarchy reads, including internal request correlation IDs that are not Discord snowflakes. `readMessage` distinguishes current text, restricted content, missing messages and unavailable reads. `readBan` distinguishes present, absent and unavailable ban state without claiming who created a ban. `readRelevantAuditEntries` bounds reconciliation to exact executor/target/operation/reason/time evidence. Reads spanning a Gateway outage are rejected. Gateway and moderation transport share this reader; no external I/O enters a transaction.

`ReplyPolicy.shouldConsiderReply`, `validateAudience` and `validateReply` are called by admission, acceptance and dispatch. They reject invalid dates, obsolete or mismatched audiences/destinations, unbounded output and enabled mentions in generated replies. Knowledge validity still belongs to KnowledgeService. Public Community and Discord DTOs now contain the actual definitions consumed by their owners rather than speculative field catalogs.

`TaskRegistry.resolveHandler` recognizes only exact supported kind/version pairs. Each worker lane uses its fair `runOne` scan without increasing concurrency. Bot completion and recovery handlers own loop composition while business services retain claims, acceptance, reconciliation and cleanup. `/yuna kick` is connected to normalization and StaffModerationService; command registration remains an operator action.

## Plan disposition

These are review units from the original remaining-work plan, now grouped by delivered behavior. Automated verification proves local behavior with fake external boundaries; it does not replace a live server acceptance session.

| Original items | Delivered implementation and evidence |
| --- | --- |
| P1–P4 | Current-state documentation; recovery from rejected Gateway owner callbacks; real PostgreSQL acceptance/invalidation/rollback races; cancellation versus committed delivery and unknown-send recovery. |
| P6–P8 | CI workflow, V8 coverage reporting, AST dependency/cycle checks, and file/method documentation checks. Local checks do not establish that hosted CI has run. |
| O1–O6b | Current owner bootstrap, scoped grants/revocation, native permission checks, pause/resume, channel and feature configuration, revision fencing, transactional audit and bounded status commands. |
| O7–O8 | Exact decimal guild budgets, admitted price snapshots, atomic reservations, late settlement, conservative unknown charges and per-member quotas/preferences. |
| O9–O10c | Bounded payload/metadata cleanup, owner removal dispositions and generation-safe reinstall. Unresolved effects, charges and required lineage remain explicitly retained. |
| O11a–O11c | One-bot session ownership, bounded process lifecycle, health CLI, supervisor/log templates, actual isolated backup/restore rehearsal and finite fake-provider load exercise. |
| J1–J3 | Typed Choice/Noul/Score adapter and durable moderation/debate worker routes with owner acceptance. Fake or uncertain output cannot establish misconduct. |
| M1a–M9 | Original-only intake and reports, immutable policy/evidence, bounded observation, typed rule assessment, findings, warning/ban/unban intents, shared target execution, reconciliation, audit and cleanup. |
| M10 | Automatic warning/ban execution is implemented and tested. The starter and `/yuna setup` use built-in LLM/Jev moderation: warnings for supported misconduct and bans for severe harm requiring removal. No per-incident staff decision or handwritten rules is needed. No live deployment was activated by source tests. |
| K1–K2 | Authorized knowledge approval/replacement/retirement, visibility-aware lexical retrieval and invalidation through provider disclosure and sending. |
| N1–N4 | Explicit private memory consent, member-submitted facts, inspection/search, withdrawal/forget/expiry and removal. No silent chat extraction, public injection or embeddings. |
| D1–D3 | Exact-scope participant consent, explicit submissions, frozen transcript/rubric, typed Jev evaluation, deterministic totals, optional paired scoring, publication and cleanup. |
| P5 and deployment acceptance | Still requires an operator's live Discord/provider session, real response-quality evaluation and deployment-specific timings. No credentials were used or external command registration, migration or deployment performed here. |

The optional kick, governance, artifact-storage and embedding component methods are now implemented as described below. Kick command integration is complete; the other components still need deployment/workflow integration as recorded in the audit. Autonomous participation, semantic retrieval, inferred memory, media-content moderation, coordinated spam/raid detection and multiple active bot owners remain outside the released feature scope.

## Optional component methods completed on 28 October

The fifteen documented method responsibilities have executable implementations. Kick methods reuse the established moderation owners rather than introducing a duplicate coordinator. These additions do not register Discord commands, apply production migrations, provision initial custodians or enable provider disclosure from Memory.

| Planned methods | Executable owner and reason |
| --- | --- |
| `prepareKick` | [StaffModerationService.requestKick](src/contexts/moderation/staff-moderation.service.ts) validates a separately authenticated caller, exact kick grant, current membership, permissions and hierarchy before persisting intent. |
| `dispatch`, `recordOutcome`, `reconcile`, `recoverDueActions` | [ActionExecutionService](src/contexts/moderation/action-execution.service.ts) shares the existing target gate, durable attempt, outcome recording and bounded recovery across warnings, bans, unbans and kicks. `recordOutcome` is private so callers cannot manufacture transport evidence. |
| `kickMember` | [DiscordModerationTransport.execute](src/discord/moderation-transport.ts) sends the exact recorded kick once. Recovery requires matching `MEMBER_KICK` audit evidence; a departed target alone does not establish success. Status authorization remains read-only and works after departure. |
| `proposePlan`, `approvePlan`, `consumeApproval`, `enrollCustodian` | [GovernanceService](src/contexts/administration/governance.service.ts) owns immutable scoped proposals, distinct current custodian approvals, one-time transaction-bound consumption and independently authenticated candidate acceptance. |
| `applyApprovedPlan` | [ApprovedPlanHandlers](apps/bot/approved-plan.handlers.ts) applies the fixed capability-grant/revocation vocabulary through existing AuthorityService methods in the same transaction as plan consumption. An owner rejection rolls back all operations, consumption and audit. |
| `storeBounded`, `openAuthorized`, `deleteExpired` | [ArtifactStore](src/platform/artifacts/artifact.store.ts) persists ownership before capture/upload, verifies bytes/type/hash, checks current disclosure authority and retains retryable cleanup through the late-upload horizon. |
| `embedTexts` | [EmbeddingService](src/ai/embeddings/embedding.service.ts) performs one bounded OpenRouter embedding request, or explicit deterministic fake execution, and returns vectors bound to exact input references/hashes and model/dimensions. |

Governance is explicitly constructed with a revisioned quorum/lifetime/retention policy and requires the existing staged tables. The current owner proposes/applies plans; approvers need an explicit guild-wide `governance.custodian` grant and fresh native administrator membership. Requesters and grant recipients cannot approve their own plans. Consumption rechecks policy, expiry, original proposer authority and every contributing approver's grant revision. Initial custodians still need a separately reviewed provisioning path; ordinary owner grant commands do not issue the special capability. Enrollment follows invite → candidate acceptance → approved completion; generic plan application cannot skip candidate consent. Supported plan operations are exact capability grants and revocations, not arbitrary feature calls or executable payloads.

Artifact flow is durable record → bounded capture/type/hash verification → current owner authorization and upload claim → external upload → conditional publication. Reads check exact purpose/audience/revision and owner or Jobs release authority before and after bounded storage I/O. Cleanup commits unavailability before deletion and only confirms deletion after a delete begun beyond the upload horizon. A deployment must supply a storage adapter, byte-based MIME verifier and transaction-local owner authorization callback. The storage backend must enforce the write cutoff even if an uploader crashes; a client-side timeout cannot guarantee that late bytes will never appear. There is no default vendor, bucket, public media route or image-assessment workflow.

Embedding input is versioned and bounded to sixteen texts, 8 KiB each and 64 KiB total, with 1–4096 explicitly requested dimensions. The adapter snapshots input, rejects mismatched hashes, duplicate references, missing/duplicate indexes, nonfinite coordinates, wrong dimensions/models and invalid usage. Response reads are capped at 2 MiB and share one cancellation/deadline boundary with the request. It never retries automatically; failed dispatched calls retain possible spend, and missing usage remains unknown. No credentials or source text enter error diagnostics. Worker admission, reservations, result acceptance, vector persistence and semantic retrieval remain owner integration work; this adapter does not activate them.

Verification lives in `tests/integration/moderation-actions.postgres.test.ts`, `tests/integration/governance.postgres.test.ts`, `tests/integration/artifacts.postgres.test.ts`, `tests/administration/governance-dto.test.ts`, `tests/discord/moderation-transport.test.ts` and `tests/ai/embedding.service.test.ts`. These exercise component behavior using fake external boundaries and isolated PostgreSQL, not live Discord or provider quality.

Contract references: [Discord member removal](https://docs.discord.com/developers/resources/guild#remove-guild-member), [Discord audit logs](https://docs.discord.com/developers/resources/audit-log), [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html), [MikroORM transactions](https://mikro-orm.io/docs/transactions), [Node streams](https://nodejs.org/docs/latest-v24.x/api/webstreams.html), and [OpenRouter embedding requests](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request).

## Default policy and member controls

[config/yuna.example.json](config/yuna.example.json) selects `moderation.mode: autonomous`. [createAutonomousModerationPolicy](src/platform/config/autonomous-moderation.ts) expands it into `community_conduct` (warning) and `severe_harm` (ban), with quotation/reporting/educational/fictional-context exclusions. Bans additionally require Jev's `banNecessary` support and violation confidence/probability of at least 0.98. These gates do not establish real-world model accuracy. Original body and established author are required; model uncertainty, missing evidence and unsupported attribution cannot become punishment. Automatic bans delete no message history.

`/yuna setup` verifies and enrolls the current owner, then [prepareServerConfiguration](apps/bot/moderation-setup.handlers.ts) selects the preset and calls [DiscordStateReader.readServerRules](src/discord/state-reader.ts) outside the configuration transaction. Discovery reads the designated rules channel and clearly named rules/guidelines text channels, retaining topics and current owner/administrator/Manage Guild messages. It is bounded to five channels, the latest 100 messages each, eight complete sources and 8 KiB. Links, embeds, attachments and older history are not imported. Coverage is explicit; an unavailable snapshot cannot replace the active configuration.

[ServerRulesSnapshot](src/platform/config/server-rules.ts) binds each source's guild, channel, message/author when applicable, complete text and SHA-256 hash. ConfigurationService reauthorizes and publishes an immutable policy containing that snapshot. ModerationPolicy supplies it to Jev as separate quoted guidance alongside original evidence and its channel ID. Guidance supplements the built-in criteria; it cannot override exclusions or evidence requirements, order sanctions or target named accounts. `/yuna configure` refreshes it, and `/yuna status` reports mode, source count and coverage. Guidance persists across restarts and with immutable policy history after removal (`moderation_policy_guidance_retained`).

The starter allows 1,000 server provider attempts and ten member-requested attempts per UTC day. [config/yuna.budgeted.example.json](config/yuna.budgeted.example.json) adds USD 5.00 per server and USD 0.50 per member. Prices are deliberately empty: monetary caps block calls until an operator supplies verified, versioned prices and sufficient conservative token bounds. These are editable sample limits, not model-price claims or guarantees about an external provider's bill.

`env:REPLY_MODEL` and `env:JEV_MODEL` are the only environment selectors accepted inside policy files. They resolve to explicit model IDs without reading arbitrary environment secrets. A policy file is bounded, validated and frozen; `/yuna configure` authorizes its persisted revision. Optional features cannot be approved when their composition dependency is absent. Unconfigured installations retain the compatibility baseline: Community only, twenty guild attempts, no automatic moderation or currency budget. Without a file, `/yuna setup` and `/yuna configure` enable automatic moderation while preserving the other default settings; both model selectors are required.

Members can inspect `/yuna usage`, lower their allowance with `/yuna limit`, and return to server defaults with `/yuna limit-clear`. Personal preferences never raise server limits. Conversation requests and Debate initiation count against the authenticated requester's allowance; automatic moderation counts against the guild allowance. Paired scoring creates two provider attempts. Settings persist across an installation generation change until explicitly cleared or removed. A currency mismatch is reported and blocks claims; an old cap is never relabeled as a different currency.

Every claim reserves before provider dispatch under shared guild/day locks. Attempt counts do not refund; known unused monetary capacity can be released, but ambiguous provider spend remains reserved. Late usage may settle the admitted price once without reviving a stale task or effect. Unknown or unpriced spend is displayed as unknown rather than zero.

## Data flows and ownership

### Conversation and approved knowledge

```text
Human name call, mention or reply → transport-normalized identity and source
 → bounded same-channel history + current/public channel names
 → installation/safety/channel gate → durable intake and request
 → approved visible knowledge + bounded input → community.generate
 → restricted claim → input release → provider-start gate → DeepSeek
 → durable result → owner current-binding acceptance + reply intent
 → fresh source/permissions → one Discord send → known/unknown outcome
```

`callsYunaByName` accepts a standalone, case-insensitive “Yuna” without a slash command or Discord ping. Names inside code blocks, inline code and quoted lines do not activate her. Explicit mentions and verified same-channel replies still work; other messages remain quiet. Bot, webhook and system messages cannot trigger replies.

`DiscordStateReader.readConversationContext` supplies the actual server/current channel names, at most 24 public channel names visible to everyone and Yuna, and up to eight complete recent messages from the same channel. One REST page reads at most 20 messages before the caller's message, restricted to the preceding 15 minutes. The requester and bot need View Channel and Read Message History; missing access or unavailable history does not invent context. Threads keep their own audience. The directory can be partial; private channel names are not exported into other channels. This context is read only when called and is not a permanent chat archive or personal memory.

Source text, previous reply, serialized chat context and approved knowledge share the 6,000-character input bound. `IntakeService.bindChatContext` records exact hashes in a separate current-context namespace, never the original moderation-evidence namespace. Edit/delete tombstones beat late reads; existing pending uses are canceled. Migration 010 adds an independent worker check at claim, disclosure and provider start. `validateContextBindings` checks the same sources again at acceptance and dispatch. Channel/role changes and Gateway gaps fence old snapshots. Context payloads follow ordinary conversation retention/removal; they are quoted data and cannot authorize sanctions, permission changes or administration. Already disclosed or sent content cannot be recalled.

Only approved, visible knowledge entries supplement the chat context. Their exact IDs, revisions, hashes, audience and expiry remain checked at worker release/start, result acceptance and dispatch. Retrieval is lexical, bounded and deterministic; it does not promise semantic matching.

### Moderation

```text
Authentic MESSAGE_CREATE → canonical case and retained original evidence
 → moderation.observe → exact supported original quotes
 → one moderation.assess per enabled rule → bound findings
 → strongest supported policy operation → durable action intent
 → target execution gate + current authority/native facts
 → warning/ban/unban transport → observed outcome/reconciliation
```

Moderation does not require a mention. A report references a captured original; reporter allegations and current REST fetches cannot manufacture missing original evidence. Later edits/deletions do not replace retained evidence. One observation feeds sequential rule assessments. Only findings supporting the exact selected effect and deletion scope authorize that effect. Intent, accepted finding/result and execution or cancellation are transactionally audited with references, without copied message text.

Staff requests name the exact target and operation and require both current native permission and scoped Yuna capability. Unban additionally requires an explicit request from a current Discord administrator. Automatic actions use accepted policy/evidence/finding bindings. Unknown effects block conflicting target actions across installation generations and are never treated as failed merely because a lease expired. Warning failure or repetition is not evidence for a ban.

### Private memory

```text
Member consent → member-submitted bounded fact → private scope
 → same-member inspection/search → withdrawal/forget/expiry
 → immediate disclosure fence → bounded payload/metadata deletion
```

Memory uses authenticated member identity, installation scope and explicit submissions. It does not infer facts from messages, use a provider, create embeddings or copy memory into public replies. Withdrawal and forgetting remain available while ordinary admission is paused or the feature is disabled. Cleanup never relies on an active feature gate to honor privacy requests.

### Structured debates

```text
Proposal with rubric, audience, payer, model and retention
 → each participant reviews full private scope attachment and consents to its hash
 → start → explicit self-authored submissions → frozen snapshot/rubric
 → debates.assess (and optional speaker-reversed assessment)
 → owner validates sufficiency/confidence/bindings and calculates exact totals
 → current consent/safety/channel checks → one public result publication
```

Only the two invited participants can inspect and act on their session. Channel history is not collected. Scores come from typed rubric answers; weights and totals use deterministic decimal arithmetic. Insufficient, fake, low-confidence or inconsistent paired assessments remain inconclusive. Results confer no authority or moderation consequences. Lifecycle and publication audits retain bounded references without private transcript or score copies. Consent withdrawal cancels pending work and erases retained payloads; it cannot recall a publication already sent. Unknown publication outcomes require exact bot/channel/nonce/hash evidence and are never blindly resent.

## Function and navigation index

Use `/yuna channel-status` to read the exact mode and revision before changing a channel. Methods below are the main entry points. Private helpers and entity transitions have local comments explaining narrower validation, locking and retention responsibilities.

| File / entry points | Purpose and reason to exist |
| --- | --- |
| [runtime-config.ts](src/platform/config/runtime-config.ts): `loadBotConfig`, `loadWorkerConfig`, `loadHealthConfig` | Validate immutable role-specific settings without reading unrelated credentials or opening I/O. |
| [policy-config.ts](src/platform/config/policy-config.ts): `loadPolicyConfig`, `validatePolicyConfig` | Bound and validate an editable model-independent policy before an authorized owner approves it. |
| [migrate.ts](src/platform/db/migrations/migrate.ts): `prepareDatabase` | Explicit administrator transaction for checksummed upgrades, role restrictions and exact allowed grants. Runtime startup never applies DDL. |
| [db.module.ts](src/platform/db/db.module.ts): `createDatabaseResource` | Lazily acquire, probe, expose and close an ORM connection. Workers discover no business entities. |
| [application.ts](src/platform/runtime/application.ts), [process.ts](src/platform/runtime/process.ts): `startApplication`, `runApplicationProcess` | Ordered startup, cancellation, reverse cleanup, sanitized fatal errors and a bounded process exit. |
| [bot-ownership.ts](src/platform/runtime/bot-ownership.ts): `createBotOwnership` | Dedicated PostgreSQL session lock prevents simultaneous bot owners and triggers shutdown on ownership loss. |
| [bot.module.ts](apps/bot/bot.module.ts): `createBotResources` | Composition root wires feature owners, Gateway callbacks, results, maintenance, privacy cleanup and removal acknowledgments. |
| [ai-worker.module.ts](apps/ai-worker/ai-worker.module.ts): `createWorkerResources` | One shared lane limit rotates through conversation, moderation observation/assessment and Debate assessment. |
| [discord.module.ts](src/discord/discord.module.ts): `DiscordGateway` | Own SDK lifecycle and external reads/effects; normalize identity, privately acknowledge commands and suppress mentions. |
| [input-normalizer.ts](src/discord/input-normalizer.ts) and command modules | Validate and copy transport primitives. Commands never supply trusted actor identity through options. |
| [register-discord-commands.ts](apps/admin/register-discord-commands.ts) | Explicit CLI upserts only the guild's Yuna command, preserving unrelated commands. |
| [guild-lifecycle.service.ts](src/contexts/administration/guild-lifecycle.service.ts): `registerGuild`, `lockAdmission`, `lockFeatureAdmission`, `lockPrivacy`, `recordAvailability` | Own installation/safety order, availability fencing and privacy access independent of ordinary feature admission. |
| [authority.service.ts](src/contexts/administration/authority.service.ts): `bootstrapOwner`, `grantCapability`, `revokeGrant` | Verify current native facts, enroll scoped authority and prevent stale grants from authorizing work. |
| [configuration.service.ts](src/contexts/administration/configuration.service.ts), [safety.service.ts](src/contexts/administration/safety.service.ts) | Persist approved configuration and pause/resume revisions with affected-work invalidation and audit. |
| [removal.service.ts](src/contexts/administration/removal.service.ts): `beginRemoval`, `runCleanup` | Fence first, resume bounded owner cleanup and retain honest completion/retained dispositions before reinstall. |
| [intake.service.ts](src/platform/intake/intake.service.ts) | Deduplicate ingress, retain original/current-source provenance and erase payloads without silently restoring expired originals. |
| [conversation.service.ts](src/contexts/community/conversation.service.ts), [reply-delivery.service.ts](src/contexts/community/reply-delivery.service.ts) | Own conversation admission, acceptance, cancellation, one-attempt delivery, reconciliation and cleanup. |
| [knowledge.service.ts](src/contexts/community/knowledge.service.ts) | Authorize approval/retirement and return only bounded visible, current knowledge with exact provenance. |
| [moderation.service.ts](src/contexts/moderation/moderation.service.ts) | Own original-message/report cases, immutable policy publication, evidence retention and removal. |
| [moderation-workflow.service.ts](src/contexts/moderation/moderation-workflow.service.ts): `admitCase`, `acceptResult`, `runMaintenance` | Register observation/assessment stages and accept exact current findings/actions in the acknowledgment transaction. |
| [moderation.policy.ts](src/contexts/moderation/moderation.policy.ts) | Pure evidence/exclusion/threshold policy; separates supported conduct from uncertain model output. |
| [staff-moderation.service.ts](src/contexts/moderation/staff-moderation.service.ts), [action-execution.service.ts](src/contexts/moderation/action-execution.service.ts) | Explicit staff admission and shared target dispatch/reconciliation with current authority and native facts. |
| [memory.service.ts](src/contexts/memory/memory.service.ts) | Member consent, explicit facts, private retrieval and deletion with no provider or public-copy path. |
| [debate.service.ts](src/contexts/debates/debate.service.ts), [debate-scoring.policy.ts](src/contexts/debates/debate-scoring.policy.ts), [debate-publication.service.ts](src/contexts/debates/debate-publication.service.ts) | Consent-bound snapshots, typed assessments, deterministic scoring and once-attempted publication/cleanup. |
| [task.service.ts](src/platform/jobs/task.service.ts), moderation/debate task services | Register reciprocal durable task/input records, expose bound completions, recover attempts and acknowledge owner disposition. |
| Worker stores and [SQL migrations](src/platform/db/migrations/README.md) | Parameterized claim/release/start/finish functions enforce exact lease, scope, deadline, budget and owner binding without direct worker table access. |
| [task.handlers.ts](apps/ai-worker/task.handlers.ts), moderation/debate handlers | Claim → disclosure → start record → one provider call → durable completion. Saving errors never trigger a second provider request. |
| [llm.service.ts](src/ai/llm/llm.service.ts), [jev.service.ts](src/ai/jev/jev.service.ts) | Fixed provider protocol, bounded body/deadline, strict typed results and safe errors; preserve usage without granting business authority. |
| [user-usage.service.ts](src/platform/usage/user-usage.service.ts), [usage.service.ts](src/platform/usage/usage.service.ts) | Member-owned lower limits, exact spend/status and safe accounting cleanup. Claims/settlement reuse admitted SQL accounting. |
| [audit.recorder.ts](src/platform/audit/audit.recorder.ts): `recordTransition`, `recordControlChange`, `purgeExpired` | Idempotent transactional references and explicit audit lifetime without prompt/response payload copies. |
| [task-wakeup.ts](src/platform/jobs/task-wakeup.ts), [background-loop.ts](src/platform/runtime/background-loop.ts) | Reconnectable empty notification hints plus durable scans; separate fresh work from slower recovery. |
| [latency.ts](src/platform/runtime/latency.ts), [health.ts](src/platform/runtime/health.ts), [health CLI](apps/bot/health.ts) | Content-free committed timings and read-only readiness/backlog inspection without provider credentials. |

Reuse existing validators, pure policy, entity transitions, owner transactions, task stores and the temporary PostgreSQL helper before adding another abstraction. File headers describe purpose; method comments explain intent and invariants. Standard JSON has adjacent documentation instead of invalid inline comments. Historical migrations retain their original checksums; migration descriptions live beside them.

## Concurrency, cleanup and operating limits

Each callback/job uses a fresh ORM fork. Shared owner mutations serialize through installation → safety → relevant source/workflow rows. Claims additionally serialize shared guild/day attempt and money accounting. Exact target gates serialize moderation effects across installations. Database uniqueness prevents duplicate receipts, attempts and acceptance. Scoped foreign keys and private security-definer helpers independently validate worker authority.

Provider and Discord I/O happen outside database transactions. A committed dispatch is the local boundary: revocation before it can prevent an effect; revocation afterward cannot unsend a remote request. Unknown outcomes remain explicit. There is no exactly-once remote-effect guarantee.

Notifications carry no content or authority. Listeners establish LISTEN before scanning and latch revisions before waiting; missed notifications are recovered through polling. Worker lanes share one configured bound instead of multiplying concurrency per feature. Shutdown cancels external calls, drains local work and closes sessions within the process deadline.

Retention separates payload lifetime, metadata lifetime and accounting lifetime. Eligible terminal conversation and Debate graphs can be deleted together; active work and unknown charges/effects remain. Moderation and knowledge preserve minimal replay/provenance references where needed. Guild removal first closes admission, then records each owner's complete/retained disposition; it does not claim unresolved references were erased. Backups require their own privacy/retention controls.

Health reports current installation/safety/availability and the live ownership lock. It does not prove provider reachability or that an idle worker is alive. Supervisor templates, log rotation guidance and the backup/restore procedure are in [OPERATIONS.md](docs/OPERATIONS.md). Nothing is installed by building the repository.

## Verification and remaining acceptance

On 29 October 2026, `npm run test:all` passed all 65 suites and 631 tests after adding name calls, channel names and bounded recent chat context alongside automatic moderation setup and server guidance import. The TypeScript build, `npm run check:docs` and `git diff --check` also passed. Coverage includes real isolated PostgreSQL upgrades from versions 1–9, persisted context disclosure, edit/delete cancellation before claim/disclosure/start/send, independent worker rejection of stale context, policy persistence and automatic warning/ban execution. External responses are controlled fixtures; no live Discord deployment or real-model judgment quality is established by these tests. Run `npm run test:coverage` when a fresh coverage report is needed; no new coverage percentage is claimed for this change. PostgreSQL integration tests must run serially and need local server binaries and permission to create and clean up temporary shared memory. The test helper uses isolated disposable databases; it does not migrate the user's running database.

The suite covers exact role grants and nine-step upgrades, real-lock concurrency, rollback, source/policy/safety invalidation, unknown effects/costs, consent/withdrawal/deletion, quotas and currency changes, subprocess lifecycle, private transport attachments, and dependency boundaries. The operations suite performs a real isolated dump/restore and a bounded thirty-input fake load with twenty admitted tasks, four worker lanes and twenty unique replies. Those finite measurements do not establish production capacity.

Live Discord/provider acceptance, operational installation, real model-quality review and sustained deployment load remain unperformed. The operator guide specifies those checks. Price examples require verified operator-supplied rates. No live command registration, provider charge, production database change, commit or push was performed.

## Primary references used

- [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html), [exact numeric types](https://www.postgresql.org/docs/current/datatype-numeric.html), [LISTEN](https://www.postgresql.org/docs/current/sql-listen.html), [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html), [pg_locks](https://www.postgresql.org/docs/current/view-pg-locks.html): owner locks, decimal accounting and durable-notification recovery.
- [MikroORM transactions](https://mikro-orm.io/docs/transactions), [node-postgres client](https://node-postgres.com/apis/client): transactional ownership and dedicated session lifecycle.
- [Discord interactions](https://docs.discord.com/developers/interactions/receiving-and-responding), [commands](https://docs.discord.com/developers/interactions/application-commands), [permissions](https://docs.discord.com/developers/topics/permissions) and installed discord.js source: private replies, native authority and bounded effects.
- [DeepSeek API](https://api-docs.deepseek.com/), [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request), [Jev guide](https://openrouter.ai/docs/guides/community/jev), [Typesafe confidence](https://docs.typesafe.ai/confidence): protocol and typed uncertainty semantics. Model names remain configuration, not permanent availability promises.
- [Jest configuration](https://jestjs.io/docs/configuration), [asynchronous tests](https://jestjs.io/docs/asynchronous), [setup-node](https://github.com/actions/setup-node): repeatable checks and coverage. No hosted CI result is claimed from a local workflow file.
