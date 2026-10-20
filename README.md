# Yuna

Yuna is a planned Discord assistant for conversation, server help, moderation, administration, personal memory and structured debates.

**Current state: a runnable first conversation milestone.** Yuna responds to mentions and replies in one configured Discord server, using DeepSeek directly or a deterministic fake. PostgreSQL stores input, task claims, results and reply intents; bot and worker have separate database roles. Moderation, Jev decisions, memory and debates remain staged.

**[Install and test on this Mac](docs/LOCAL_TEST.md).** The guide covers Discord permissions, local PostgreSQL, environment files and a no-cost first reply.

The current [implementation guide](Yuna.md) stages basic conversation first: mention/reply triggers, DeepSeek through its direct API, and Jev through OpenRouter for structured decisions. It tracks small implementation tasks, reusable functions, data flow and verification; broader features follow later.

Start with the [architecture plan](docs/ARCHITECTURE_PLAN.md) for proposed ownership, durable intake, task lifecycle, configuration, cleanup and implementation order. Use the [entity model plan](docs/DATA_MODEL_REFERENCE.md) for target fields, constraints, ownership, lifecycle and verified Discord API implications across all 40 planned records. It includes original-only moderation, durable accepted reply content and immutable installation identities. The entity layer implements storage and local invariants; orchestration, permission checks and external effects remain service work.

The [DTO and module reference](docs/DTO_REFERENCE.md) maps request/response DTOs to their owning services, explains trusted caller context, and lists each module's public providers. The scaffold now gives concrete DTOs their own files under the relevant feature's `dto/` directory.

## Layout

| Directory | Purpose |
| --- | --- |
| `apps/bot` | Discord-facing runtime composition, inbound handlers, completion routing and recovery entry points. |
| `apps/ai-worker` | Restricted worker composition, explicit task registration and individual AI task handlers. |
| `src/contexts/community` | Conversation requests, approved knowledge, reply policy and delivery. |
| `src/contexts/moderation` | Cases, evidence, findings, warnings, sanctions and authenticated staff actions. |
| `src/contexts/administration` | Guild lifecycle, grants, safety state, usage policy and optional approvals. |
| `src/contexts/memory` | Personal consent, facts, permitted retrieval and deletion. |
| `src/contexts/debates` | Participation, transcripts, rubric evaluation and publication. |
| `src/ai` | Plain capability contracts and separate LLM/Jev/embedding integrations. |
| `src/discord` | Normalized event/context DTOs, reads and effects, independent of business contexts. |
| `src/platform` | Database boundaries, durable jobs, usage accounting, artifacts and audit. |
| `tests` | Entity, configuration, lifecycle, subprocess and PostgreSQL tests; plans for future business scenarios. |
| `docs` | Architecture plan, entity lookup, DTO/module reference and future decision records. |

## Entities and remaining scaffolds

Entity files contain real classes and mappings. Their methods use supplied values only; callers must perform authorization, locking and related writes in one transaction. Comments explain decisions such as immutable original evidence, uncertain effects and payload retention. Runtime configuration, conversation admission, durable jobs, DeepSeek and Discord adapters are implemented. Broader feature services and DTOs remain planned.

Services coordinate I/O and workflows. Policies evaluate supplied values. Entities protect their local state transitions. Adapters communicate with external systems. A service does not need to exist for every entity.

Within a feature, `dto/` holds named use-case inputs and serialized outputs; `contracts.ts` holds trusted bindings and shared domain values; `entities/` holds private persistence records. Related DTOs share a use-case file. DTOs describe fields and validation, not database tables or business methods. Feature services use native ORM repositories/query APIs in the caller's transaction; custom repositories are introduced only for concrete queries that warrant them.

Discord handlers fill the transport/controller role. They validate feature arguments and separately supply verified caller identity. Module files name the services other modules may inject; policies, entity registrations and repositories stay private. DTO and schema files are plain imports rather than injectable services.

The scaffold reserves all five business contexts; it does not commit them all to the first release. Optional governance and kick behavior are marked in their files. Memory and Debates are staged features. Add future features through a clear owner, narrow contracts and ordinary application composition; create new files when a concrete feature needs them.

## Working boundaries

- A context owns its entities and accepted business output, and uses another context only through its public contract/service boundary.
- Moderation owns the original-capture-to-observation-to-assessment workflow. Edits/deletion never replace the original evidence; an uncaptured original remains missing. AI handlers execute individual prepared tasks.
- Provider modules do not import contexts, Jobs, Discord or one another.
- Discord handlers live in `apps/bot`; the Discord adapters do not import feature services.
- Task/result binding, durable action intent and uncertainty are explicit. No exactly-once external-effect guarantee is assumed.
- Personal memory, moderation evidence and debate transcripts have separate ownership and retention.

Entity and integration tests enforce storage rules and the conversation transaction boundaries. Moderation authority and sanction execution remain unimplemented.

## Moderation and abuse protection

Moderation is a core planned capability; the conversation-first rollout stages its implementation later. The repository implements moderation records and local storage guards, but it does not yet detect scammers, spammers, abusers or griefers, verify live staff permissions, or execute sanctions. Production rule definitions, LLM observation prompts, Jev questions and end-to-end enforcement are still missing. The following describes the intended enforcement flow and the additional coverage needed before these protections can be claimed.

### Assessment and banning

The planned automatic flow is:

1. Retain the attributable original message and its evidence coverage.
2. Use the LLM to extract supported observations, source references and missing-context indicators from prepared input.
3. Use Jev to answer predefined rule questions with typed answers and explicit uncertainty.
4. Have Moderation validate the result and apply the versioned rule criteria, exclusions and action mapping.
5. Commit the accepted findings, retained reasons and exact action intent together.
6. Recheck current authority, target eligibility, safety and action limits, then call Discord and record the observed outcome.

| Accepted outcome | Permitted policy response |
| --- | --- |
| Established violation | An automatic ban when the enabled rule maps that violation to banning; no staff review is required. |
| Supported suspicion | A warning when the rule permits it; suspicion cannot authorize a ban. |
| Allowed conduct | No enforcement. |
| Incomplete evidence, model uncertainty or provider failure | No punishment based on that outcome alone; record the incomplete or failed assessment explicitly. |

A confidence score alone does not establish a violation. Repeated warnings do not themselves prove misconduct, and failure to deliver a warning cannot escalate to a ban. Quotation, reporting and permitted-discussion exclusions must preserve who actually authored the conduct. Jev supplies an assessment, not generated explanations or authority; accepted reasons must remain grounded in the retained evidence and policy. Neither AI adapter chooses a target, grants permissions, calls Discord or advances the workflow. See [ModerationService](src/contexts/moderation/moderation.service.ts), [ModerationPolicy](src/contexts/moderation/moderation.policy.ts) and [JevService](src/ai/jev/jev.service.ts).

Ban and unban work for the same target shares an execution gate. An unknown Discord outcome blocks conflicting work until reconciled; lease expiry, a timeout or the current presence of a ban does not justify a blind retry or reversal. Message-history deletion requires explicit authorization in the recorded action. See [BanService](src/contexts/moderation/ban.service.ts).

### Admin access and staff actions

Explicit staff commands follow a model-independent path. Admission requires authenticated Discord identity, an appropriate scoped Yuna capability grant, current native permissions and the exact operation/target. Native Discord permission alone does not enroll staff in Yuna. Role names, conversational claims, quoted commands, personal memory and model output cannot grant authority. Current permissions and bindings must be rechecked before dispatch; revoked or expired grants invalidate affected pending work. See [AuthorityService](src/contexts/administration/authority.service.ts) and [StaffModerationService](src/contexts/moderation/staff-moderation.service.ts).

Unbanning requires an explicit request through Yuna from a current Discord administrator, bound to the exact actor, target and request. AI results, timers and optional governance cannot initiate an unban. Recovery may continue an existing authorized request under current checks, but cannot invent one.

Discord also limits what Yuna can execute: banning requires `BAN_MEMBERS`, and a target member's highest role must be below the bot's highest role. Giving Yuna `ADMINISTRATOR` does not bypass that hierarchy restriction. An administrator target still requires applicable policy and target checks; administrator status does not give Yuna permission to ignore Discord's restrictions. [Discord permission hierarchy](https://docs.discord.com/developers/topics/permissions#permission-hierarchy), [ban endpoint](https://docs.discord.com/developers/resources/guild#create-guild-ban).

### Threat coverage still needed

These are detection requirements and design gaps, not implemented features:

| Threat | Required detection and policy work | AI role |
| --- | --- | --- |
| Scammers | Define credential-theft, fraudulent-offer and impersonation rules, required evidence and exclusions. Add trustworthy supporting signals where needed; a suspicious-looking URL alone does not establish fraud. | Interpret attributable content and assess specific scam criteria. |
| Spammers | Define bounded per-user/channel rate windows, repeated-content detection, mention counts and aggregation across messages. | Assess ambiguous meaning; code counts events and applies rate rules. |
| Abusers | Define threats, targeted abuse and harassment criteria, including quotation/reporting exclusions and evidence needed for patterns across messages. | Extract supported statements and assess the defined criteria without inferring guilt from uncertainty. |
| Griefers and coordinated raids | Define correlated join/message activity and attributable channel, role and other administrative changes, with explicit containment permissions and limits. | Assess context where useful; code verifies event provenance, permissions and exact actions. |

The current case model covers **one original message**. Grouped incidents, recurring behavior and strikes require a separate design; the existing action records do not supply those detectors. Destructive administrative actions also need event evidence beyond message content. See the [selected modeling decisions](docs/DATA_MODEL_REFERENCE.md#selected-modeling-decisions).

Original-only moderation preserves a captured violation after editing or deletion, but it leaves a coverage gap: a harmless original later edited into a scam is not assessed as new misconduct under the current policy. Missing original content remains incomplete. Supporting harmful edits would require an explicit evidence-policy change while preserving the original; later text must never be substituted as the original evidence.

### Stress testing and adversarial verification

Before enabling automatic enforcement, verify both moderation quality and execution behavior. Existing entity, configuration and PostgreSQL tests do not demonstrate detection accuracy, adversarial robustness or sustained throughput. [Business scenarios](tests/scenarios/README.md) and [boundary checks](tests/boundaries/README.md) remain planned.

- Test legitimate conversation, quotations, reports, scam/abuse examples and evasive variants. Measure false positives and missed violations separately by rule; test uncertainty and missing evidence explicitly.
- Test forged admin claims, quoted commands and prompt injection in source content. They must not create authority, change the target or disclose unauthorized context.
- Race duplicate intake, competing workers, stale completions and simultaneous staff/automatic actions. Assert deduplicated admission and acceptance, correct target binding and no blind duplicate dispatch.
- Race grant revocation, role changes, pause and guild removal against pending execution. Newly unauthorized work must not dispatch; already-dispatched or unknown effects still require reconciliation.
- Inject provider outages, malformed outputs, timeouts, process restarts and ambiguous Discord responses. Preserve durable work and evidence, bound retries and account for each provider attempt without turning failures into findings.
- Exercise bursts and sustained load with explicit queue/admission bounds, worker concurrency, provider budgets and action limits. Measure processing latency, backlog, recovery and cost; configured concurrency alone is not proof of capacity. Conversation filtering must not suppress enabled moderation intake, and exhausted moderation work must remain visible for recovery or an explicit retention-expiry disposition.
- Verify Discord per-route/global rate-limit handling and honor `Retry-After`/`retry_after`. Separate rate-limit responses from uncertain action outcomes; do not resend an ambiguous destructive operation blindly. [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits).

Traffic targets, overload behavior, rule thresholds, retention and acceptable error rates still need to be selected and tested. The [implementation guide](Yuna.md) and [architecture plan](docs/ARCHITECTURE_PLAN.md) define the staged work and concurrency boundaries; no production stress-test or model-quality result is claimed here.

## Runtime configuration and local startup

Follow [the local test guide](docs/LOCAL_TEST.md). Copy `.env.admin.example`, `.env.bot.example` and `.env.worker.example` to their local `.env` names and fill the required values. `npm run db:prepare` explicitly applies versioned migrations and provisions restricted runtime roles in an existing database. Runtime startup never migrates a schema.

After building, run `npm run local:worker` and `npm run local:bot` in separate terminals. The bot uses `DISCORD_GUILD_ID` to allow one server and handles explicit mentions/replies in every readable channel with send/history permission. For a zero-cost Discord test use bot `REPLY_MODEL=fake` and worker `DEEPSEEK_MODE=fake`. For live replies set `REPLY_MODEL` and `DEEPSEEK_MODEL` to the same model and put the DeepSeek key only in `.env.worker`. Jev stays disabled.

The first test allows 20 claimed attempts per UTC day across the server, at most 20 pending requests, 4,000 input characters, one previous Yuna reply up to 2,000 characters, 512 output tokens and a two-minute reply deadline. This is a request-count limit, not a currency budget. No automatic provider retries or uncertain Discord resends are enabled.

`loadBotConfig`/`loadWorkerConfig` validate frozen role-specific settings without I/O. Fake modes require development/test. `start:bot` and `start:worker` accept already-exported settings; `local:*` loads the corresponding file. Worker concurrency defaults to one, request timeout to 30 seconds. Use one bot process for this pilot.

Ctrl+C and SIGTERM drain resources in reverse order with a ten-second shutdown limit. Unexpected raw driver/provider errors and credentials are not printed. Restarts and gateway gaps invalidate pending conversation work; ambiguous prior sends remain reconciliation-only.

## Build and verify

Use Node.js 24 or newer. Dependencies and their lockfile are pinned.

```sh
npm ci
npm run typecheck
npm test
npm run test:db
```

Tests run through Jest after TypeScript compilation. `npm test` includes entity, configuration, lifecycle and subprocess checks; `npm run test:db` runs PostgreSQL checks. Use `npm run test:all` to run both in one command. See the [verification guide](tests/README.md) for the ESM setup and test-environment compatibility details.

The database tests require PostgreSQL `initdb`, `pg_ctl` and `psql` on PATH. They create a private temporary cluster using a Unix socket, run the complete schema and persistence checks, then stop and remove that cluster. They do not connect to an existing database or Discord.

`npm run schema:sql` prints the core schema for review; append `-- --include-staged` to include optional governance, Memory and Debates. The generator combines entity mappings with scoped foreign keys and cross-row guards. Using MikroORM's schema generator alone omits those extra guards. No application startup synchronizes a schema. `db:prepare` applies the reviewed core and conversation-worker migrations explicitly; the generated schema command remains a review tool.

## Implementation boundaries

- Automatic policy bans need supported original-evidence findings and no staff review.
- Unbans require an explicit request through Yuna from a current Discord administrator. The entity requires the exact internal request/authority record; services must still obtain and recheck live permissions.
- Original evidence, accepted reasons and action intent commit before dispatch. Intake/Jobs payload cleanup does not remove Moderation's retained copy.
- Default schema registration includes 27 core entities. Thirteen staged entities are opt-in; their classes do not enable those features.
- Database revisions detect competing ORM updates. They do not replace the source/target locks and transaction boundaries specified in the architecture.

Next is the first manual server test, followed by conversation-quality tuning and a separately scoped Jev decision contract. The broader moderation protections above remain planned.
