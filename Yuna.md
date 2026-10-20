# Yuna implementation guide

Last updated: 21 October 2026. Function index, data flow and implementation status requested in [considerations.txt](considerations.txt). Start with [the Mac/server test guide](docs/LOCAL_TEST.md).

## Confirmed scope and current state

Basic conversation comes first: mention Yuna or reply to her in any channel she can read/send to in one configured server. Run on this Mac. DeepSeek uses its direct API; Jev will use OpenRouter for structured decisions later. Reuse existing code and add missing functions when required, as clarified by the user.

The conversation slice is now executable: Discord Gateway, durable intake, Community admission, restricted worker task functions, fake/live DeepSeek, owner acceptance, Discord delivery/reconciliation, payload cleanup, explicit migrations and separate CLI processes. All 40 entity mappings remain; the core registry has 27 entities and 13 staged entities are opt-in. Moderation, memory, debates, knowledge retrieval, Jev execution and broader administration remain scaffolds.

This pilot uses ordinary TypeScript composition, MikroORM transactions and PostgreSQL polling. It does not need NestJS, Redis or a queue service. Existing outbox records track durable wake-ups; polling the authoritative task/result rows recovers lost wake-ups.

## First working flow

```text
Discord Gateway human mention/reply in allowed server
  -> transport normalization + verified reply author
  -> installation/safety gate + channel settings
  -> transaction: immutable source observation + Community receipt
       + ConversationRequest + AiTask/PreparedInput + outbox
  -> worker claims compatible task + reserves one daily attempt
  -> separately recheck/release prepared input + record provider start
  -> DeepSeek direct API or deterministic fake (outside transaction)
  -> transaction: immutable result + usage + completion outbox
  -> Community checks current source/safety/settings/deadline
       + copies accepted text to ReplyDelivery + acknowledges result
  -> fresh Discord source/permissions + locked delivery claim
  -> one Discord send outside transaction, with nonce and no pings
  -> store delivered / definitive failure / unknown
  -> reconcile unknown only from matching Discord evidence
```

Only Community receives intake in this slice. The stored text is normalized conversational input, not a claim of original moderation evidence. Future moderation intake must independently capture attributable original content and retain its own evidence; filtering conversations must not suppress moderation.

## Operating limits and recovery

| Choice | Pilot behavior |
| --- | --- |
| Trigger and scope | Mention/reply; one required server ID; all accessible channels; human messages only. |
| Context | Current text ≤4,000 characters plus replied-to Yuna text ≤2,000. No archive or personal memory. |
| Reply | 512 output tokens, ≤2,000 characters, no mention notifications. |
| Deadline | Two minutes from message creation; 30-second provider ceiling by default, additionally bounded by lease/deadline. |
| Load/cost | ≤20 pending requests; ≤20 claims per UTC day/server including fake/failure. A call-count cap, not a dollar budget. |
| Retry | One provider attempt and one Discord send; ambiguous outcomes never automatically resend. |
| Retention | Payloads expire after 24 hours; running bot purges bounded batches. Technical IDs/hashes/usage/deduplication metadata remain. |
| Availability | Gateway gaps and restarts advance safety revision; old claims cannot disclose/dispatch, pending replies are canceled. |

Model request and resolved response IDs are recorded separately: providers may return a resolved version of a requested alias. No invented dollar prices are stored; unpriced usage remains an explicitly estimated liability. Daily attempt reservations do not refund on failure or restart. No external I/O runs while a database transaction is held.

A message edit/delete invalidates current-source work and cancels an unsent reply. It does not regenerate automatically or recall an already sent response. A crash between recording dispatch and observing Discord's answer remains uncertain; positive reconciliation requires the bot author, source reference, nonce and content hash. Unknown sends have a separate bounded rotating scan so they cannot starve new replies.

## Reviewable code groups and function index

| Code / methods | Purpose and transaction contract |
| --- | --- |
| [Runtime configuration](src/platform/config/runtime-config.ts): `loadBotConfig`, `loadWorkerConfig` and private field readers | Validate/freeze only each role's settings, with safe field-only errors and no I/O. Require guild/model for live Discord; live Jev is rejected at composition for this milestone. |
| [Database setup](src/platform/db/migrations/migrate.ts): `prepareDatabase`, private configuration/role/privilege checks | Explicit admin operation on an existing owned database. Advisory lock, checksum ledger, versioned SQL, role passwords and restricted grants commit atomically. Runtime roles own no tables. |
| [Database resource](src/platform/db/db.module.ts): `createDatabaseResource`, `start`, `getOrm`, `stop` | Lazily own/probe a connection, expose it only while ready, close safely. Bot uses core metadata; worker metadata stays empty. No startup DDL. |
| [Lifecycle](src/platform/runtime/application.ts): `startApplication`, `shutdown`, `createFakeResource` | Ordered startup, reverse rollback/shutdown, shared cancellation. Fake Discord is lifecycle-only; use live Discord plus fake DeepSeek for an actual server test. |
| [CLI lifecycle](src/platform/runtime/process.ts): `runApplicationProcess` | Own SIGINT/SIGTERM listeners and ten-second shutdown limit; log safe status without secrets. |
| [Bot composition](apps/bot/bot.module.ts): `createBotResources` | Connect database → Gateway → Community, serialize availability transitions, poll recovery/acceptance/delivery/cleanup; drain before closing database. |
| [Worker composition](apps/ai-worker/ai-worker.module.ts): `createWorkerResources` | Verify restricted claim capability, start bounded consumer lanes, abort and drain them before closing database. |
| [Discord normalization](src/discord/input-normalizer.ts): `normalizeConversationMessage`, `hashMessageSource`, `hashDiscordContent` | Normalize trigger/context without business entities; source hashing detects edits. Verify referenced Yuna authors, ignore system/bot/webhook/DM/wrong-server messages. |
| [Discord adapter](src/discord/discord.module.ts): `DiscordGateway.start/stop`, `readSource`, `sendReply`, `findReply` | SDK lifecycle, cancellation and read/effect boundary. Fresh source reads, cached SDK permission checks, Discord final enforcement, no automatic retries, conservative unknown outcomes. |
| [Guild lifecycle](src/contexts/administration/guild-lifecycle.service.ts): `registerGuild`, `lockAdmission`, `recordAvailability` | Own scoped installation/safety locks; preserve identity, enforce pause/availability, fence old work after connection gaps. New install enables Community only. |
| [Intake](src/platform/intake/intake.service.ts): `receiveInput`, `invalidate`, `current`, `purgeExpired` | Join owner's transaction; deduplicate source, retain observation, create unresolved tombstones for late events, check current source and erase expired payload. |
| [Conversation](src/contexts/community/conversation.service.ts): `receiveInput`, `cancelRequest`, `cancelPending`, `acceptReplyResults`, `runRetention` | Own request admission/cancellation, accepted text and reply intent; each operation owns a short transaction. Acknowledge task result with acceptance/discard in the same commit. |
| [Jobs owner](src/platform/jobs/task.service.ts): `registerTask`, `recoverExpired`, `pendingResults`, `acknowledge`, `isResultCurrent`, `invalidateSource`, `purgeExpired` | Register reciprocal task/input records in caller transaction, recover leases, expose narrow completion/current-result facts, retain acknowledgment and erase payloads. |
| [Worker store](src/platform/jobs/worker-task.store.ts): `claimNext`, `releasePreparedInput`, `recordProviderStart`, `recordResult` | Parameterized calls to restricted database functions. Claims expose authority metadata; only the separate release gate discloses prepared text. No direct table access. |
| [Worker SQL](src/platform/db/migrations/conversation-worker.sql): claim/release/start/finish/recover functions and internal gates | Lock installation/safety/source/request/task, enforce exact binding/lease/deadline, reserve daily usage and immutable results. Security-definer functions use a fixed trusted search path; public schema creation is revoked. |
| [Usage helper](src/platform/usage/conversation-usage.ts): `createConversationUsagePolicy` | Create the explicit server-test daily-attempt policy using existing usage entities; no fictitious model pricing. |
| [Task handler](apps/ai-worker/task.handlers.ts): `AiTaskHandlers.runOne` | Claim → disclosure → provider-start gate → one LLM call → persistence. Recheck time after storage gates; uncertain cost survives errors. Never retry a call because saving its result failed. |
| [LLM](src/ai/llm/llm.service.ts): `LlmService.generateReply`, safe `LlmError` and private validators | Fixed direct endpoint, bounded input/body/deadline, strict output/usage validation, whole-grapheme truncation and deterministic fake. No tools, hidden reasoning or raw provider errors returned. |
| [Reply delivery](src/contexts/community/reply-delivery.service.ts): `recoverDueDeliveries`, `dispatch`, `reconcile` | Fresh external source read, locked current safety/result/source/settings check, durable one-attempt claim, external send, stored outcome. Exact evidence resolves uncertainty without resending. |

Reuse `entityOrmConfig`, combined schema generators, base record/scoped entities, existing transition methods, `invariant`, ID/date/number validators and `copyJson`. These validate local values/state; services supply current authority and transaction locks. Reuse [temporaryPostgres](tests/helpers/temporary-postgres.ts) for actual role/constraint/race tests. The [Jest clone compatibility shim](tests/setup/structured-clone.ts) is test-only and preserves the production JSON checks.

## Concurrency and verification

Every event/job/batch gets a fresh ORM fork. Mutations sharing the installation serialize on its row; safety and source gates are locked before disclosure/acceptance. Database uniqueness handles duplicate intake, task attempts and result acceptance. SQL functions independently revalidate claims and preserve terminal results against late workers. Gateway availability callbacks are serialized so stale reconnect work cannot overtake a new outage.

On 21 October 2026, `npm run test:all` built successfully and passed **161 tests across 19 suites**, including 35 PostgreSQL integration checks. `git diff --check` passed. `npm audit --omit=dev` reported zero production vulnerabilities; development tooling still reports moderate advisories and has not been force-downgraded.

The [test guide](tests/README.md) maps configuration, lifecycle/subprocess, Discord, LLM, handler, migration, worker-permission and full conversation-flow checks. Tests use explicit Jest imports and compiled ESM, real PostgreSQL and mocked external boundaries. No live Discord round trip or provider billing test has been performed. The [manual test guide](docs/LOCAL_TEST.md) is the next acceptance step.

Keep tasks reviewable, document new public behavior, test actual failure/race cases, and use current official sources for external contracts. Do not weaken existing schema constraints to make the worker run. General administration/moderation rules remain in [the architecture](docs/ARCHITECTURE_PLAN.md), [entity reference](docs/DATA_MODEL_REFERENCE.md) and [DTO reference](docs/DTO_REFERENCE.md).

## Provider research and integration decisions

Checked against official documentation on 21 October 2026. Model availability can change; no live model calls were made during implementation.

- **DeepSeek direct:** the documented chat endpoint is `https://api.deepseek.com/chat/completions`. Keep the exact model ID, response limits and thinking configuration in validated runtime configuration. The test guide selects the current documented `deepseek-flash` model with thinking disabled; the model remains configurable. [DeepSeek API introduction](https://api-docs.deepseek.com/).
- **Jev model selection:** `typesafe/jev-1.14` is the pinned OpenRouter decision-model ID verified on 21 October 2026. `JEV_MODE` remains disabled until the adapter and its first code-owned decision are implemented. [OpenRouter model listing](https://openrouter.ai/typesafe/jev-1.14).
- **Jev through OpenRouter:** OpenRouter documents the Decisions API at `https://openrouter.ai/api/alpha/decisions` for typed Jev assessments. This needs its own adapter contract rather than assuming a text-completion response. Keep the exact model version configurable and retain returned request ID, resolved model, provider and usage for accounting. [OpenRouter Jev guide](https://openrouter.ai/docs/guides/community/jev), [Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request).
- **Jev semantics:** Choice selects among defined labels; Score evaluates a rubric; Noul returns a 0–1 value for a proposition. Preserve each answer type's meaning and validate question IDs and bounds. Use these outputs for narrowly defined application decisions. [TypeSafe introduction](https://docs.typesafe.ai/introduction).
- **Assessment contract constraint:** Jev does not return generated reasoning or explanations. Bind its answer to Yuna-supplied source references; do not fabricate citations or explanations to satisfy a scaffold field. Define an explicit uncertainty outcome for an inconclusive assessment. [OpenRouter Jev guide](https://openrouter.ai/docs/guides/community/jev).
- **Discord replies:** use transport-provided mention IDs and verify the referenced author for reply triggers. A reply reference can be absent or explicitly deleted. Test replies with the mention toggle disabled and configure content access accordingly; inaccessible content is an explicit missing-input outcome. [Discord message reference](https://docs.discord.com/developers/resources/message).

## Next work after the server test

1. Observe mention/reply behavior, latency and failure handling on the user's server; refine the small conversation prompt/context if needed.
2. Agree on Jev's first typed decision and uncertainty outcome, then implement its OpenRouter adapter with fixtures and recorded usage.
3. Add operational controls, actual currency-budget policy/pricing and complete metadata retention before broader deployment.
4. Implement moderation assessment/authority/enforcement as its own reviewed milestone; then consider knowledge, memory, debates and richer media.

Automatic sanctions, autonomous channel participation, production load testing and full guild-removal cleanup are not enabled by this conversation milestone.
