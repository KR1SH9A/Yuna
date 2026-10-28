# Yuna architecture plan

This reference preserves the architecture decisions and identifies the executable scope as of 21 October 2026. Community conversation and approved knowledge, Administration controls/configuration/removal, original-message Moderation and explicit staff actions, private explicit Memory, and consented Debate scoring/publication are implemented. The bot and restricted worker use ordinary TypeScript composition, native PostgreSQL transactions, notifications and recovery scans. [Yuna.md](../Yuna.md) records current verification; [local setup](LOCAL_TEST.md) explains deployment. Applying migrations and testing real credentials remain operator steps.

**Selected scope:** Moderation assesses retained original text; later edits, deletion, reports or REST fetches do not substitute for an uncaptured original. Community checks current sources and approved context again before disclosure and sending. Memory stores only explicit private submissions and uses lexical inspection; inferred facts, embeddings and public/provider memory disclosure remain future options. Debates use explicit submissions, independently recorded consent, an immutable rubric/transcript and typed Jev assessment; deterministic owner code computes scores and accepted results publish once to the consented channel. Optional multi-custodian governance and kick remain staged. There is no appeal or speech subsystem. Explicit policy mappings can authorize automatic bans; the starter maps supported violations to warnings, with no message-history deletion. Unban requires an explicit authorized administrator request.

The detailed sections retain target concepts such as optional artifact storage, inferred-memory tasks and generic routing. They do not imply those extensions are active. Kick execution, governance approval/enrollment, bounded artifact storage and embedding generation now have executable component methods; see [the method guide](../Yuna.md#optional-component-methods-completed-on-28-october) for their exact integration limits. Concrete runtime task names and current boundaries are listed in sections 7–8.

## 1. Runtime and ownership

Yuna is a modular application with two process roles. The bot receives Discord input, persists it, invokes feature services, accepts stored AI results and performs authorized Discord effects. The AI worker executes one prepared capability at a time and stores its result. PostgreSQL holds authoritative application state; the durable queue supplies recoverable wake-up signals. The deployment supports one bot owner per configured guild and concurrent worker lanes. A dedicated PostgreSQL advisory-lock session rejects a second bot and triggers shutdown if ownership is lost; automatic multi-bot failover is not implemented.

| Boundary | Owns | Does not decide |
| --- | --- | --- |
| Bot ingress | Normalized input, deduplication, delivery to installed feature consumers | Whether content violates a rule or deserves a reply |
| Business contexts | Eligibility, workflow stages, accepted decisions, configuration and retention rules | Provider protocol or queue delivery mechanics |
| Jobs | Technical task state, claims, prepared input, results and completion acknowledgment | The next business stage or a sanction |
| Usage | Atomic budget reservation and per-attempt accounting | Budget policy |
| AI capabilities | Bounded observation, assessment, generation and optional embeddings | Authority, destinations, workflow progression or database access |
| Discord adapters | Trusted normalization, current reads and explicit effects | Feature policy |
| Artifacts and Audit | Controlled storage lifecycle and bounded durable history | Business access or retention policy |

Application services coordinate work. Entities protect local transitions; policies evaluate supplied values without I/O. External adapters sit behind narrow contracts. Persisted feature workflows are ordinary state machines, not a generic workflow engine. The outbox pattern connects committed state to queue delivery. No universal AI service, base repository, command bus or plugin framework is needed.

Each event, completion or recovery batch gets a fresh ORM context. Nested local operations join the caller's native ORM transaction. Provider, Discord and object-store calls run outside database transactions. A worker must have genuinely restricted data access: scoped database operations or a narrow service boundary, no business-table credentials or broad artifact-bucket reads. A TypeScript interface alone is not an access boundary.

### DTOs and feature organization

Keep each feature's module, services, policies, `dto/`, internal `contracts.ts` and private `entities/` together. Request and response DTOs have concrete use-case names; a DTO does not mirror an entity automatically. Related shapes can share a small use-case file. AI task payloads retain separate versioned schemas under `src/ai/contracts`.

Discord handlers perform the controller role. They normalize external events, validate the selected feature's arguments and supply verified identity separately. `InteractionContextDto` contains transport-derived identity; the bot obtains current installation state and supplies the transport-neutral `TrustedCallerContext` defined by Administration. A user cannot choose their actor, guild or authority through an input DTO. Services still check current permissions, revisions and business invariants. Automatic policy work uses its explicit policy-authority binding rather than inventing a human caller.

Validation must be wired into the actual Discord and queue entry points. Validate normalized/retained snapshots, queue envelopes and AI capability inputs/results at their boundaries; do not rely on TypeScript annotations alone. Response DTOs allowlist serialized fields after the service applies access rules. Never return ORM entities or include SDK objects in DTOs. Executable entry points use bounded runtime validators; TypeScript shapes alone are never treated as validation.

Feature modules explicitly export the services consumed by bot entry points, completion handlers and recovery. Entity registrations, policies and repositories stay private. DTOs/types are data imports, not dependency-injection providers. Native ORM repositories and queries are the starting persistence mechanism. Introduce a feature-owned custom repository only when concrete repeated or complex queries justify one; services remain responsible for transactions and business decisions.


### Entity ownership and Discord lifecycle

The entity model plan keeps the existing 40 concepts, including four core additions. Community owns accepted reply text before acknowledging a Jobs result; delivery outcome is authoritative on ReplyDelivery rather than a second request flag. Findings carry immutable capture and policy references. Approved knowledge content is immutable; replacement is a new approved entry, while visibility changes use existing authorized revision updates.

Discord IDs are strings; native user/member/channel data is not mirrored as a general database model. A missing message or restricted content is not fabricated evidence. Current API updates must be normalized from their supported shape, without assuming every update is partial. Attachment URLs are temporary locators. Channel sends and deferred interaction-original responses have different destination/expiry contracts; secrets stay outside Jobs and audit. Ban/unban/kick may succeed without an external action ID. A temporary guild outage is not an uninstall.

Local application methods join or create short transactions and perform no external I/O. Orchestration methods such as dispatch enter outside an active transaction, read external facts, claim locally, perform the external operation after commit, then record its observed outcome in another short transaction. Shared service classes do not imply that every method has the same transaction contract.

## 2. Durable input starts before feature routing

Introduce two concepts under bot ingress: `IntakeEvent` and `IntakeDelivery`. They are separate from AI tasks because input may be ignored, recorded without inference, or delivered to more than one owner.

1. Normalize trusted Discord identity and source metadata; bound the untrusted content. In one short transaction, persist the event, its intended deliveries and a wake-up outbox entry. **That commit is local durable acceptance.**
2. Initially register Moderation and Community as explicit consumers. Create a Community receipt for potentially eligible input; Community makes the final reply-eligibility decision. Never let conversation pruning suppress moderation.
3. Claim one receipt with a lease and generation. In one transaction, validate the claim, invoke the owner's local admission operation, persist its workflow/tasks/outbox and acknowledge the receipt. A receipt finishes when the feature durably accepts, ignores or expires the input, not when AI or Discord work finishes.
4. Recover unfinished receipts from database state. A crash before the owner transaction commits permits replay; a crash after commit cannot admit the same receipt twice.

Deduplicate events by `(installationId, sourceEventKey)` with enforced guild scope, and receipts by `(installationId, eventId, owner)`. Installation identity is immutable; command/report receipts do not change the current-message marker. Use stable create/delete/interaction identities and exact available transport identity for update replay. Without a reliable update event identity, retain a new local observation; only coalesce an unchanged current fingerprint under the source gate. A historical hash match must not drop A → B → A, and no hash establishes remote ordering.

Serialize intake commits for the relevant ordering key and record a local ingress sequence. Moderation deduplicates the original message capture and reports that refer to it; current-source consumers such as Community can serialize admission by channel. Long-running inference does not hold that admission lock. A local sequence records local receipt order, not complete Discord history. Current-source owners reject demonstrably older observations and record missing or ambiguous coverage instead of inventing it. Moderation separately binds retained original evidence, including a missing-original disposition when necessary.

Retain a latest-observed source revision/deletion marker in `IntakeEvent` metadata, with a stable `sourceKey` and at most one current marker per guild/installation/source. Update it under a transaction-scoped source-key lock; keep its tombstone through outstanding work and the bounded replay window even after payload deletion. An older remote revision arriving later cannot become current merely because its ingress sequence is higher. Ambiguous ordering marks source validity unresolved until a trusted refresh can establish it; current-source work cannot assume it is current. Original-evidence work validates its retained capture separately. The small intake module can live in `src/platform/intake`, with consumer routing in `apps/bot`. Its public `lockAndReadSource` operation lets owners validate currentness without importing bot application code. Registration and acceptance acquire that same source gate. Recording a newer or unresolved source observation also invalidates affected `current_source` prepared inputs through Jobs in that transaction, so delayed older admission cannot restore eligibility. It does not invalidate `original_evidence` moderation work solely because the message was edited or deleted. That work remains subject to capture validity, retention, policy, permissions, safety and installation checks. This records the latest source state Yuna has observed, not an omniscient view of Discord.

The Community deadline is established at intake and copied unchanged into the conversation request, relevant tasks and reply delivery. Check it before paid work, acceptance and any new send. Restart and retry never extend it. A send already in flight or with an unknown outcome still needs reconciliation after expiry. Moderation does not inherit the reply deadline: processing exhaustion parks its intake visibly for recovery. A hard retention deadline requires an explicit failed receipt and operational notice, not silent loss.

Keep snapshots until required consumers have acknowledged and captured their own data, then apply the bounded intake retention policy. Retain only minimal deduplication metadata afterward. This is not a permanent message archive. A stored attachment URL does not preserve its bytes: track durable captured artifacts and missing-media coverage separately. Upstream events that never reach the local commit are outside this recovery guarantee.

Proposed ingress operations: `recordInput`, `claimDelivery`, `completeDelivery`, `recoverDueDeliveries` and `purgeExpiredSnapshots`. Keep normalization in the existing Discord adapter; the bot composition root owns consumer routing. A small `IntakeService` and its records are sufficient when implemented. A future authorized report lookup can use the receipt owner reference rather than an unbounded report array on a case.

## 3. One authoritative AI task lifecycle

`AiTask` is the sole authority for technical execution state. Queue status, feature workflow state and attempt state cannot substitute for it.

| State | Meaning | Allowed next state |
| --- | --- | --- |
| `READY` | Bound input is registered; no current execution | `RUNNING`, `PARKED`, `TERMINAL` |
| `RUNNING` | One current attempt holds execution authority | `RETRY_WAIT`, `TERMINAL` |
| `RETRY_WAIT` | A retryable attempt ended; bounded retry is due later | `RUNNING`, `PARKED`, `TERMINAL` |
| `PARKED` | Required schema, capability or deployment support is unavailable | `READY` after deliberate validation, or `TERMINAL` |
| `TERMINAL` | Execution has ended with one stored outcome | None |

Check compatibility before creating an attempt or releasing content. Parking does not consume a provider retry. Deadlines still apply to parked work. A failure discovered during an attempt first finishes/fences that attempt; normal retry eligibility is then reevaluated. A terminal task is never reopened. Reassessment creates a new task and a new owner operation revision or expected-task binding.

Keep these records distinct:

| Record | Answers |
| --- | --- |
| `AiTask` | What immutable work was requested, and is execution still active? |
| `TaskAttempt` | Who tried to execute it, under which lease, and what happened? |
| `TaskResult` | What is the single terminal outcome of the logical task? |
| `TaskAcceptance` | Did its owner apply or discard that terminal outcome? |

**There is one terminal result per task.** Intermediate retryable failures stay on attempts. They do not notify the owner. A terminal result has outcome `success`, `uncertain`, `failure`, `canceled` or `expired`; its attempt reference is nullable when no provider attempt produced it. A valid uncertain answer ends execution; retries must not repeatedly sample until an answer becomes favorable.

The transaction that finishes a task writes the terminal result and completion outbox together. Cancellation racing a result uses the same conditional task transition: one wins, and late output cannot replace it. Late usage evidence remains recordable independently.

There is at most one immutable `TaskAcceptance` per terminal result, using `accepted` or `discarded` plus a reason. Acceptance means the owner applied the outcome, including a failure; it does not mean a sanction was authorized. Validate the owner's operation identity, expected task where applicable and revisions, apply the owner change and record acknowledgment in the same transaction. A duplicated completion is harmless. An obsolete result gets a discarded acknowledgment without advancing newer work.

An unavailable completion consumer parks **completion delivery**, not inference. Retain its terminal result and an explicit routing reason; do not call the provider again. Recovery distinguishes unexecuted tasks, expired attempts and unacknowledged terminal results.

Ordinary result cleanup follows owner acknowledgment. If a privacy deletion or hard owner-defined retention limit requires earlier erasure, record `payloadUnavailable`, the purge reason and a pending owner-discard disposition while removing the content. Keep the minimal result envelope for completion routing. A later acceptor must apply the unavailable/expired outcome and acknowledge discard; it cannot use an empty success payload or re-run inference automatically. This deletion state does not rewrite the original execution outcome. Removing an owner deployment still requires draining these dispositions.

Method responsibilities when implementation begins:

| Component | Operations to clarify or add |
| --- | --- |
| `TaskService` | `registerTask`, `cancelTask`, `invalidatePreparedWork`, `recordAcceptance`; cancellation creates a terminal outcome and handles unused reservations |
| `WorkerTaskStore` | `claimTask`, `releasePreparedInput`, `renewLease`, proposed `recordAttemptOutcome`; `recordResult` only installs a terminal result under the current generation |
| `TaskRecoveryService` | Recover leases, expire tasks, resume explicitly unparked work, republish signals and redeliver stored results using the same transition rules |

## 4. Cleanup and accounting must reach a terminal disposition

Physical deletion is asynchronous; permission to use content is revoked first. Keep durable progress on the records already responsible for the data. `MemoryDeletionRequest` coordinates memory erasure; `GuildInstallation` coordinates guild removal. Do not add a generic deletion framework.

| Data | Application owner and cleanup path | Completion condition |
| --- | --- | --- |
| Intake copies | Intake service invalidates/purges snapshots and owned artifact references | No retained payload; required receipt/dedup metadata has a bounded policy |
| Prepared input and results | Jobs `purgeExpiredPayloads` and scope invalidation | Content removed; no released capability can be newly issued; minimal task/acknowledgment metadata retained as allowed |
| Moderation records | Moderation `runRetention` / `removeGuildData` | Evidence and finding payloads handled under explicit evidence retention; effects and audit metadata separately bounded |
| Community records | Community `runRetention` / `removeGuildData` | Request and reply content erased; unsent delivery invalidated; unknown sends reconciled |
| Memory | Existing deletion/expiry flow, extended to acknowledgments for every copied payload | Facts/vectors and applicable Intake, Jobs, Community and artifact copies removed or a specific lawful/configured retention disposition recorded |
| Debates | Debate `runRetention` / `removeGuildData` when enabled | Transcript, snapshots and evaluations purged; pending publication invalidated |
| Artifacts | `ArtifactStore.deleteExpired` / recovery | Actual object deletion confirmed or retryable failure retained |
| Audit and Usage | Owner-configured retention methods | Minimal records retain only justified references and accounting, never duplicate private prompts |

Memory erasure does not automatically erase independently owned moderation evidence. Each owner must state what it retains and why. A copy made for memory or reply preparation cannot escape erasure merely by moving into a job payload. The first release must choose concrete retention durations and removal rules; a data-producing feature cannot be enabled while its cleanup policy is unspecified.

Persist an `ArtifactRecord` with a known storage key **before** uploading. Use one physical object per owning retention scope: independently retained evidence and reply/input copies receive separate records/objects. References within one scope may not extend that owner's retention deadline. This avoids hidden cross-context reference counting. Upload outside the transaction; finalize to `READY` conditionally. Only ready, currently authorized objects are readable. Recovery deletes abandoned uploads. Because an upload may finish after deletion started, use bounded upload lifetimes plus repeated cleanup through that horizon or an enforced temporary-object expiry. A failed upload must not produce an untracked permanent object.

Append bounded `AuditEntry` records in the audited local transaction. Record intent before external dispatch and record observed outcome afterward. Audit records reference facts and revisions; they do not copy entire messages, prompts or transcripts.

| Accounting event | Required treatment |
| --- | --- |
| First task registration | Atomically reserve the first bounded attempt; attach that reservation when claimed |
| Retry | Reserve a separate allowance for the new attempt; previously uncertain spend still counts |
| Cancel/expire before disclosure | Release provably unused capacity as part of finalization |
| Input released, then timeout/cancel | Preserve conservative liability until evidence establishes actual or absent spend |
| Result discarded as stale | Retain actual provider cost; acceptance is unrelated to billing |
| Late usage evidence | Idempotently settle the original attempt; never let a later timeout overwrite known actual usage |
| Reservation recovery | Release only demonstrably unused reservations; reconcile unknown ones without treating expiry as a refund |

Add bounded recovery entry points for intake, task expiry, reservation reconciliation, all enabled owners' retention, artifact cleanup and guild-removal acknowledgments. Do not place cross-context deletion queries in the scheduler. `completeRemoval` requires every recorded owner acknowledgment. `GuildInstallation` has an immutable UUID and generation; beginning removal blocks that row rather than rewriting its identity. Reinstalling creates a new row/generation and cannot revive old work. Temporary Discord unavailability only updates availability/readiness, not removal state or generation. Outstanding old-generation effects and cost liabilities remain tracked.

## 5. Configuration changes have named application owners

Entities validate local values; these services authorize and commit configuration changes. Do not expose generic table editing as an administration API.

| Change | Application operation | Required consequence |
| --- | --- | --- |
| Initial installation and verified owner enrollment | `GuildLifecycleService.registerGuild` + proposed `AuthorityService.bootstrapOwner` | Bind authenticated current guild-owner facts; idempotent bootstrap for this generation |
| Grant or revoke a capability | Proposed `AuthorityService.grantCapability` / existing `revokeGrant` | Validate actor authority, exact scope, expiry and expected revision; invalidate affected undispatched work |
| Pause/resume | `SafetyService` | Advance safety revision; invalidate work as required; resume never revives a previously canceled task |
| Usage limits | Proposed `GuildLifecycleService.updateUsagePolicy` | Authorize, validate and revise policy; serialize with reservation admission; preserve prior usage liabilities |
| Feature admission | Proposed `GuildLifecycleService.setFeatureAdmission` | Explicitly select drain or cancel; retain completion and cleanup support for outstanding work |
| Channel reply behavior | Proposed `ConversationService.updateChannelReplySettings` | Advance settings revision; invalidate obsolete pending requests/tasks/deliveries |
| Approved knowledge | `KnowledgeService` approval/retirement plus `changeVisibility` | Advance entry revision; invalidate affected disclosed-context preparation and pending replies |
| Moderation policy | Proposed `ModerationService.publishPolicyRevision` | Append and immediately activate a new immutable guild revision; invalidate obsolete automatic work |
| Memory consent | `MemoryService` consent/deletion operations | Advance privacy fence; block disclosure before cleanup |
| Debate rubric | Proposed `DebateService.publishRubricRevision` | Append immutable rubric; existing frozen sessions retain their explicitly bound rubric |

Installation-level usage/admission settings fit the existing lifecycle service initially. Split configuration management into another service only if actual use cases make that class unwieldy. There is no service per settings entity.

For initial moderation policy management, publishing is activation: the highest committed guild policy revision is active, under a serialized publication operation. Rollback publishes another revision. Draft scheduling and a separate active-policy entity are deferred. Provider secrets belong in validated runtime secret configuration, never guild policy records.

## 6. Revisions have three different jobs

| Revision kind | Purpose | Examples |
| --- | --- | --- |
| Row revision | Prevent concurrent lost updates | Request, grant or settings row version |
| Business validity binding | Describe exactly which source and policy authorize work | Evidence/policy revision, knowledge version, memory privacy fence, installation generation |
| Execution generation | Reject writes from a superseded executor | Task lease generation, action claim generation |

Do not use one generic version number for all three. Every task stores only the relevant immutable bindings, supplied by its owner, including immutable installation identity and the declared source use (`original_evidence`, `current_source` or none). Sequenced workflows store their expected task for each pending stage/variant. Independent one-shot operations use an owner-supplied unique operation key, explicit supersession rules and validity bindings instead. Model output supplies none of these identities.

Check bindings at four boundaries:

1. **Registration:** owner validates the selected original-evidence or current-source binding, permission, current scopes and deadline before committing input and task.
2. **Disclosure:** Jobs checks current prepared-input eligibility, deadline and execution claim before releasing bytes or artifact access.
3. **Acceptance:** owner checks current operation, expected task where applicable, relevant revisions, invalidation and result schema before applying the outcome.
4. **Effect dispatch:** effect owner checks current installation, safety, authority, applicable original-evidence/current-source binding, audience and deadline before authorizing a new external call. Source deletion alone does not revoke a retained original-evidence finding.

Initially use `PreparedInput.eligible` with indexed scope/revision bindings. Registration and invalidation lock the same existing owner scope rows, such as `MemoryScope` or `GuildInstallation`. Invalidation updates affected prepared inputs in that transaction. Release locks the prepared-input row and verifies its gate. Jobs never needs to query business tables. Introduce a Jobs-owned scope gate only if measured invalidation fan-out makes these updates unsuitable.

Document one lock order for implementation: installation/safety, source-key gates, owner scope rows, target/workflow rows, task/input/attempt rows, then budget/reservation rows. Sort multiple rows within a category by stable identity. Registration, invalidation, release and recovery must follow the same order for rows they share; no lower-level operation may acquire an earlier-ranked lock afterward. Native ORM transactions and explicit locks are enough initially.

A memory privacy fence invalidates **pending work**. It does not automatically invalidate every surviving unchanged fact or require all vectors to be rebuilt after an unrelated deletion. Stored retrieval still checks current consent, audience, fact existence, expiry, content hash and the selected embedding model/version/dimensions. Initially select that model through versioned runtime configuration consumed by Memory; an explicit future migration can allow multiple indexes. Knowledge retirement similarly invalidates pending use of the retired version.

Database fencing controls permission to start local dispatch; it cannot recall a provider request or Discord action already in flight. Fetch current Discord facts outside transactions and revalidate local bindings before claiming dispatch. Unknown external outcomes must be reconciled before retry, including after cancellation or deadline expiry.

An event-driven moderation action must have a committed database record linked to its exact original evidence, accepted finding and policy before Discord dispatch. Store original text/source attribution and capture details in EvidenceRevision, retained media through its artifacts, and the actual attempt/outcome on the action records. Keep these owner-owned details for the configured action-evidence review period within explicit evidence/artifact deadlines; routine Intake/Jobs cleanup cannot erase them. Required evidence purge leaves a visible unavailable time/reason, not a replacement fetched from the current message. Reuse the existing records without duplicating evidence into action JSON.

## 7. Every supported task has an end-to-end route

Persist task `kind` and `schemaVersion` separately; `@1` below is shorthand. Task kinds identify feature use cases. Several kinds may reuse one capability handler. Model and prompt versions are separate bindings.

| Kind | Status and owner | Worker capability | Acceptance |
| --- | --- | --- | --- |
| `community.generate@1` | Active Community conversation | `LlmService.generateReply` | `ConversationService.acceptReplyResults`, including current source and approved-knowledge bindings |
| `moderation.observe@1` | Active original-evidence observation | `LlmService.observeContent` | `ModerationWorkflowService.acceptResult` |
| `moderation.assess@1` | Active policy assessment | `JevService.assessQuestions` | `ModerationWorkflowService.acceptResult`; deterministic policy creates intent |
| `debates.assess@1` | Active frozen original/reversed variants | `JevService.assessQuestions` | `DebateService.acceptEvaluation`; deterministic scoring owns totals and uncertainty |
| `community.route@1` | Future optional routing; direct mentions/replies currently use code policy | Proposed assessment capability | Not admitted by the current runtime |
| `memory.propose_facts@1`, `memory.embed_fact@1` | Future optional inferred facts/indexing | Proposed extraction/embedding capabilities | Not admitted; shipped Memory uses explicit submissions and no provider calls |

Each route needs guild/immutable installation ID, owner operation reference, relevant revision bindings and source-use mode, source/input hash, deadline and usage linkage; sequenced workflows also bind stage and expected task. Validate feature-specific output too: known question IDs, permitted routing candidates, fact provenance, or frozen transcript/rubric/variant. Required paired debate evaluations use distinct tasks and expected-task slots; workflow/stage alone is not unique.

For one-shot Memory proposals, the operation key includes scope, source identity/revision, purpose and explicit proposal/configuration revision, within the guild/installation. Different sources can proceed concurrently. Deduplication alone does not establish currentness: validate the retained ingress source marker as well as current consent. A deliberate replacement invalidates its specific predecessors, including terminal but unaccepted work, without blocking unrelated proposals. Fact embedding instead binds an existing fact/content hash and selected model/version/dimensions. Apply facts or vectors and `TaskAcceptance` atomically. These operations need no additional Memory workflow entity initially; Jobs stores the owner-supplied operation identity and invalidation metadata, and Memory owns its meaning.

Keep static worker and bot completion maps in their composition roots. Shared contract metadata imports no services. When implemented, a boundary check must compare admitted kind/version pairs with both handler and acceptance coverage. A feature cannot admit work unless the deployed worker and owner continuation support it. A worker that cannot handle a version must not globally park a task that another deployed worker supports; version-aware dispatch/admission distinguishes worker-local incompatibility from deployment-wide unavailability.

Defer the current unowned explanation schema/handler/capability from the implementation plan until a feature supplies its requester and acceptor. Memory extraction requires its explicit fact-proposal contract; do not disguise it as generic reply generation.

The first Memory retrieval design can use bounded database/lexical lookup. Fact indexing alone does not complete semantic search. If semantic retrieval is selected later, add a complete `memory.embed_query` route, a durable retrieval request/result and a continuation back to the requesting feature. Do not hide provider I/O inside a synchronous-looking retrieval method. Those additional models and that task are **not in the selected plan**.

Disabling new admission, removing deployment support and invalidating permission are different actions. Disabled features must drain or cancel existing tasks while keeping their acceptors and cleanup handlers installed. Unsupported stored versions are explicitly parked and visible. Deployment checks must reject removal of a handler still required by outstanding work, unless an explicit maintenance disposition is supplied.

## 8. Repository organization and current boundaries

The owner services, runtime validators, task routes and cleanup for enabled features are composed directly in `apps/bot/bot.module.ts` and `apps/ai-worker/ai-worker.module.ts`. The migration runner deploys restricted functions and the selected private owner tables. Catalog comments and optional schema models remain useful design references; they do not create additional runtime routes.

| Area | Executable scope and retained extensions |
| --- | --- |
| Administration | Verified owner bootstrap; scoped grant/revoke; pause/resume; channel mode; approved file configuration; usage/feature policy; safe status; removal and audit |
| Community / Knowledge | Direct conversation, current-source gates, bounded visible approved reference retrieval, one-send delivery, and retention; semantic search and broad history retrieval remain unselected |
| Moderation | Independent original-text capture, observation/assessment, code-owned policy findings, staff ban/unban, warnings, current native execution checks and exact reconciliation; no media inspection or kick route |
| Jobs / Usage | Restricted claim/disclosure/start/result functions per active route, immutable usage snapshots, guild/member UTC-day caps, exact money and uncertainty retention; no generic workflow engine |
| Memory | Consent, explicit private facts, bounded lexical inspection, forget/withdrawal and owner cleanup; no inference, embeddings or public/provider copies |
| Debates | Full reviewable scope, two-person consent, explicit transcript, paired typed evaluation, deterministic scoring, one-send publication and erasure; no score-based authority |
| Audit / Artifacts | Transactional reference-only audit plus expiry/removal; artifact models remain available for future retained-media storage, which is not enabled |
| Optional governance | Multi-custodian plans/enrollment remain staged; baseline administration is current-owner managed |


Keep `ModerationAction` separate from `ActionAttempt`, and `AiTask` separate from `TaskAttempt`, `TaskResult` and `TaskAcceptance`. Their lifecycles differ. Reply attempt metadata can remain within `ReplyDelivery` initially; extract a record only when its actual concurrency or history requirements justify it. Governance approval authorizes an exact plan; execution consumption belongs to `ActionPlan`, not both plan and approval.

## 9. Original implementation sequence and continuing regression checks

1. **Core contracts and constraints:** agree lifecycle enums, same-guild keys, task/result uniqueness, deadlines and revision meanings. Update the design scaffold before adding runtime behavior.
2. **Durable intake plus task slice:** deliver one input to both owners, register work, execute, store a result and acknowledge it. Add the static registration coverage check.
3. **Authorization and configuration:** implement verified bootstrap, policy/settings writers and atomic invalidation before enabling automatic effects.
4. **Effects and accounting:** persist intent, fence concurrent claims, reconcile unknown outcomes and account for every attempted provider call.
5. **Cleanup and removal:** implement all enabled owners' retention and copied-data deletion; then enable the first release. Choose actual durations and budget bounds in configuration.
6. **Staged features:** add one complete request-to-acceptance-and-cleanup slice at a time. Optional records need no migrations until their feature ships.

Meaningful acceptance checks for that implementation:

- Crash after intake commit and between owner deliveries: both owners recover, with no duplicate admission.
- Restart after the reply deadline: no new late send; an unknown prior send is still reconciled.
- Retryable failure followed by success: two attempts, one terminal result and one owner acknowledgment.
- Crash after result commit: completion resumes without another provider call.
- Race source edit against current-source registration/release/acceptance: obsolete Community work cannot gain authority, while original-only Moderation remains bound to its retained original. Race grant revoke, pause, memory deletion or guild removal against relevant work: invalidated work cannot gain new disclosure or dispatch authority.
- Stale worker result: payload cannot replace the terminal outcome, but its actual usage is recorded once.
- Cancel before disclosure versus timeout after disclosure: only proven unused capacity is released.
- Crash during upload or deletion: every object is tracked and cleanup eventually reaches its recorded disposition.
- Temporarily unavailable owner/schema: no uncontrolled retry loop and no lost terminal result.
- Disable a feature or reinstall a guild: existing work drains/cancels under its original generation; old authority never revives.

The sequence above records the original design approach; current implemented scope is summarized in section 8 and [Yuna.md](../Yuna.md). Continue testing each enabled route through acceptance, delivery and erasure. Keep ordinary TypeScript composition and native transactions rather than introducing a framework to satisfy retained design catalogs.
