# Run Yuna locally

Yuna runs in one configured Discord server with a bot process, a restricted AI worker and PostgreSQL. The implemented features are direct conversation, approved server knowledge, original-message moderation, owner administration, personal usage limits, private explicit memory and consented Debate scoring. Configuration enables features; individual Memory and Debate consent is still required. Optional governance, inferred memory and semantic indexing remain outside the shipped route.

## 1. Prepare Node and PostgreSQL

Use Node.js 24 or newer and PostgreSQL 17 or newer. Install the locked dependencies in this repository:

```sh
npm ci
```

Create an empty `yuna` database owned by your administrative PostgreSQL account. Use an existing local PostgreSQL installation, or install/start one through your normal package manager. On a Homebrew Mac, the package is `postgresql@17`; consult its [installation instructions](https://formulae.brew.sh/formula/postgresql@17) for the executable path and service setup. The database preparer needs schema ownership and permission to create the two runtime login roles. Bot and worker startup never apply migrations or create databases.

## 2. Create and invite the Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create the application and bot. Obtain the bot token and enable **Message Content Intent** for original-text capture and ordinary conversation triggers.
2. Configure Guild Install with `bot` and `applications.commands`. Copy the application ID and invite it to your chosen server. Slash commands are registered explicitly in step 4. [Discord command setup](https://docs.discord.com/developers/interactions/application-commands).
3. Grant **View Channels**, **Send Messages** and **Read Message History** in the channels you will test. Conversation replies in threads also require **Send Messages in Threads** and actual thread access. Debate result publication currently supports ordinary text and announcement channels, not threads or voice channels.
4. For automatic bans and ban/unban tests, grant **Ban Members**; for kick tests, grant **Kick Members**, and place Yuna's highest role above eligible target roles. **View Audit Log** enables exact audit reconciliation after uncertain ban/unban/kick responses. Channel overrides and target hierarchy still apply. Yuna does not require Administrator for itself. [Discord permissions](https://docs.discord.com/developers/topics/permissions).
5. Enable Developer Mode in your Discord client and copy the server ID.

A public web server or tunnel is unnecessary: this deployment receives interactions over the Discord Gateway. Owner/control operations require both Yuna's application grant and fresh native Discord authority. An administrator who has not been granted a Yuna capability does not acquire it merely by seeing a command.

## 3. Create the local environment and policy files

Copy these only if the destination files do not exist:

```sh
cp -n .env.admin.example .env.admin
cp -n .env.bot.example .env.bot
cp -n .env.worker.example .env.worker
chmod 600 .env.admin .env.bot .env.worker
```

Fill the values locally. The ignored `.env` files contain credentials; the policy file contains rules, budgets and retention, never keys.

| File | Required configuration |
| --- | --- |
| `.env.admin` | Administrative database URL and distinct bot/worker database passwords. |
| `.env.bot` | Matching `BOT_DATABASE_URL`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_APPLICATION_ID`, and `REPLY_MODEL`. Set `JEV_MODEL` when enabling Debates or using the starter moderation selectors. |
| `.env.worker` | Matching `WORKER_DATABASE_URL`, provider modes/model IDs and provider keys only when using live modes. |

For the first rehearsal, use `REPLY_MODEL=fake` and `JEV_MODEL=fake` in `.env.bot`, and `DEEPSEEK_MODE=fake`, `JEV_MODE=fake` in `.env.worker`. Fake providers make no paid calls. Fake assessments remain uncertain and cannot authorize automatic sanctions. `JEV_MODE=disabled` is suitable for a conversation-only test; assessment tasks cannot complete while that route is disabled.

There are two reviewed starters:

```sh
cp -n config/yuna.example.json config/yuna.json
```

Set `YUNA_CONFIG_FILE=config/yuna.json` in `.env.bot`. The standard starter enables automatic original-text moderation, private Memory, and Debates. LLM observations plus Jev assessments produce warnings for supported misconduct or bans for severe harm requiring removal, without staff approval per incident. It allows 1,000 total provider attempts and 10 requested attempts per member per UTC day. It sets **no monetary cap** and never deletes message history.

Alternatively copy `config/yuna.budgeted.example.json`. This selects a $5.00 server budget and $0.50 member budget per UTC day, with the same attempt limits. Its price list is intentionally empty: populate verified current prices for every selected provider/model before live work can be admitted. Missing prices under monetary caps stop claims rather than treating calls as free. See [configuration details](../config/README.md).

Without `YUNA_CONFIG_FILE`, new installations use the conservative defaults: Community enabled, 20 server attempts/day, no promised dollar ceiling, and moderation/Memory/Debates disabled. Editing a file alone does not apply it. On startup, a configured file that differs from the persisted approved policy holds new conversational and automatic moderation intake until the owner applies it.

## 4. Prepare the database and register commands

```sh
npm run db:prepare
npm run register:commands
```

Database preparation builds the project, applies the versioned migrations and verifies restricted grants. Re-running preserves data and verifies checksums. The bot has only the enabled owner tables; the worker can call reviewed task functions and cannot query private business tables or raw source content directly. Keep the administrative URL and Discord token out of the worker environment.

Command registration updates this application's `/yuna` command in the configured server. Run it again after upgrading command definitions. It is an explicit remote write and is not performed automatically on bot startup.

## 5. Start, enroll the owner and apply configuration

In two project terminals:

```sh
# Terminal 1
npm run local:worker
```

```sh
# Terminal 2
npm run local:bot
```

Wait for both processes to report ready. As the **current server owner**, run `/yuna setup`, then `/yuna status`. Setup enrolls the verified owner, enables the built-in automatic moderation preset and remembers available server rules as additional guidance. Set both `REPLY_MODEL` and `JEV_MODEL` in the bot; the worker must expose matching routes. No handwritten rules file is needed. Without a policy file, setup keeps the default 20 server attempts/day and leaves Memory/Debates disabled. The starter's `env:REPLY_MODEL` and `env:JEV_MODEL` resolve only those two nonsecret model selectors.

Discovery checks the designated rules channel and clearly named rules/guidelines channels, using topics and eligible current staff messages. Give Yuna View Channel and Read Message History there. Status reports the saved source count and whether coverage is partial. See the [discovery limits and policy retention](../config/README.md#moderation-policy); this is not a full server-history crawl. Run `/yuna configure` to refresh guidance and apply the selected file. Without a file it refreshes the automatic preset. For an advanced custom policy, use `/yuna bootstrap` then `/yuna configure` instead of setup.

Try **Yuna, can you help?** as plain text: no slash command or Discord ping is needed. **@Yuna hello** and replying to Yuna's message also work, including with the reply ping disabled. She receives the actual channel name, a bounded public channel directory and recent same-channel chat, so try “Yuna, what are we discussing?” after a short conversation. Ordinary unaddressed messages stay quiet while original-message moderation runs independently within its permissions and usage limits. Commands respond ephemerally. Bot/webhook/system identities never become inferred human sanction targets.

Keep both terminals and the Mac running. Ctrl+C stops each process. After code changes, stop them, run `npm run db:prepare` and `npm run register:commands` when applicable, then restart. Only one bot may own the configured guild. A second bot is rejected, and loss of the first bot's database ownership connection causes shutdown instead of allowing two dispatchers.

For a staff kick, register the updated commands, grant the caller `moderation.kick` for the exact target/channel scope, and use `/yuna kick target:<member ID> reason:<reason>`. Both caller and bot still need native Kick Members permission and sufficient role hierarchy; the command records intent and `/yuna action` reports the observed result. This does not enable automatic kicks.

## 6. Exercise the implemented commands

Discord displays the exact option names and bounds. IDs and revisions below come from private command responses; a stale revision is rejected rather than overwriting another change.

| Commands | What to verify |
| --- | --- |
| `/yuna setup`, `status`, `bootstrap`, `configure` | Setup enrolls the current owner, enables automatic moderation and imports server guidance. Status reports revisions, mode and coverage. Configure refreshes guidance and applies the selected file, or automatic defaults when no file is selected. |
| `/yuna grant`, `revoke` | Grant a specific capability with optional channel/target restrictions; revoke at the displayed authority/row revisions. Fresh native permissions are checked again when a grant is used. |
| `/yuna pause`, `resume` | Use the displayed safety revision. Pausing fences pending disclosures/effects; resume does not revive obsolete task bindings. |
| `/yuna channel-status [channel]`, `channel` | Read the selected channel's mode and current row revision; the read defaults to this channel and requires the same scoped `community.configure` authority as editing. Use the returned revision to set `silent` or `direct`. Revision zero means no stored settings yet. Changing settings cancels pending uses in that channel. |
| `/yuna usage`, `limit`, `limit-clear` | Inspect only your own UTC-day usage. Set a stricter attempt limit, including zero, and/or an exact currency budget. Clearing a personal preference retains server/default limits and existing spend. |
| `/yuna ban`, `unban`, `kick`, `action` | Optional staff overrides create durable intent. Inspect the action ID for confirmed/failed/unknown execution; acceptance is not proof Discord changed. Unban requires an explicit request by a current administrator with its Yuna grant. |
| `/yuna report` | Name the original message and submit an allegation. A report does not replace missing original evidence or establish a violation. |
| `/yuna knowledge approve`, `read`, `search`, `visibility`, `retire` | Approve exact reference text with a recorded source and explicit audience. Channel is the default audience. Corrections create a replacement with the predecessor's current revision; retirement/audience changes invalidate pending copies. |
| `/yuna remove` | Begin removal at the displayed installation revision. New work stops; owner cleanup records complete/pending/retained dispositions. Already dispatched external effects and unresolved accounting retain their evidence. |

`knowledge.manage` operations need current native administrator authority plus an appropriate application grant. Search is lexical and bounded; only approved, unexpired entries visible to the exact source channel can enter conversation context. Knowledge remains lower-trust reference text, not instructions or authority. Retired/expired/changed entries are checked again at worker disclosure, provider start, acceptance and final delivery.

### Private Memory

1. `/yuna memory inspect` shows your current privacy revision (initially 0).
2. `/yuna memory consent granted:true revision:0 days:30` grants private storage for 1–30 days; use the current revision returned for subsequent mutations.
3. `/yuna memory remember` saves only your explicit text, up to 500 characters. At most 50 facts are retained per member; inspection is paginated and can use a literal query.
4. `/yuna memory forget` erases one named fact or all facts. Consent withdrawal also erases stored facts; shortening the retention period erases prior facts before the change commits.

Facts are private to their owner and guild installation. They are not inferred from channel history, sent to a provider, embedded, or loaded into public conversation context. Inspection, withdrawal and forgetting remain available when the feature is paused or disabled.

### Consented Debates

Use an ordinary text or announcement channel where Yuna can publish. A proposer selects an opponent, exact topic, retention duration and a JSON rubric. [The editable two-criterion example](../config/debate-rubric.example.json) is included with Yuna's source as an illustrative starting point, not a scoring-accuracy claim. Supply this complete compact JSON as the `rubric` option:

```json
{"criteria":[{"id":"reasoning","description":"Support the stated claim with connected, relevant reasons.","levels":["No relevant reasons","Some relevant reasons with gaps","Clear connected reasons"],"weight":"1"},{"id":"engagement","description":"Address the other participant's actual argument fairly and specifically.","levels":["Does not address the argument","Addresses part of the argument","Addresses its central reasoning fairly"],"weight":"1"}],"minimumWinningMargin":"0.1","minimumConfidence":0.9,"paired":true,"maximumPairDifference":1}
```

1. `/yuna debate propose` records the proposal in the current channel. The private response attaches the full topic, participants, paying initiator, model, rubric, retention and publication scope.
2. Each invited participant uses `/yuna debate status` to review that complete attachment, then `/yuna debate consent` with the exact `scope-hash` and `accept:true`. One participant cannot consent for the other.
3. `/yuna debate start` opens explicit submissions. Each participant uses `/yuna debate submit` for their own text, up to 1,000 characters per submission. The session is bounded to 20 submissions and 12,000 serialized transcript bytes.
4. `/yuna debate freeze` closes the transcript and requests the declared Jev evaluations. Paired scoring creates original/reversed evaluation tasks. Provider attempts count against the initiating participant's allowance and the server's allowance.
5. `/yuna debate result` privately shows accepted results and publication state. Accepted totals and limitations are automatically published to the consented channel, once. The owner computes totals/winner from the declared rubric; insufficient coverage/confidence or incompatible paired results stay uncertain. Scores never authorize sanctions or grants.
6. Either participant can use `consent accept:false` or `cancel`. Pending uses are fenced and retained payloads erased. A send already in flight or a published result cannot be recalled through local cancellation; unknown sends are reconciled, never blindly resent.

Debates collect explicit submissions only. They do not scrape channel history, edits or deleted messages. Full scope/result attachments avoid silently truncating the review. Removing `JEV_MODEL` prevents new evaluation-producing commands but keeps inspection, withdrawal and cleanup available.

## 7. Enable live providers and price bounds

Set `DEEPSEEK_MODE=live`, `DEEPSEEK_API_KEY` and the selected `DEEPSEEK_MODEL` in the worker. Set the identical `REPLY_MODEL` in the bot. Set `JEV_MODE=live`, `OPENROUTER_API_KEY` and a compatible `JEV_MODEL` in the worker; use the same `JEV_MODEL` in the bot. The rules and rubric do not hard-code model behavior. The adapters currently implement [DeepSeek's chat interface](https://api-docs.deepseek.com/) and [OpenRouter's Jev Decisions interface](https://openrouter.ai/docs/guides/community/jev); selecting a model name does not add a different provider protocol.

Restart after environment changes, then apply `/yuna configure` after reviewing the resolved policy. Set prices from the provider's current published rates for your selected model, including any charges relevant to that route. Price snapshots use exact decimal strings, currency, a version and conservative token ceilings. Monetary caps reserve the maximum admitted attempt cost before disclosure. Unknown/unpriced liabilities and mismatched currencies block further monetary claims; they are not reported as free calls. `/yuna usage` shows a personal currency mismatch explicitly; clear or replace that stale preference.

Conversation and observation input are bounded before sending. Priced conversation routes require at least a 32,768-token conservative input ceiling; moderation requires 65,536. Follow [the configuration guide](../config/README.md) for each route's output/input bounds. The application makes one provider request per admitted task attempt and no automatic HTTP retries. Real Discord/provider smoke tests require your credentials and are separate from automated tests.

## Retention, delivery and operational limits

- Current conversational text is limited to 4,000 characters; previous reply context to 2,000. Source, previous reply, serialized channel/chat context and approved knowledge share 6,000 characters. Context includes up to eight complete messages from the last 15 minutes, drawn from one page of 20 messages before the call. It includes current channel/server names and up to 24 public channel names; private channel names stay out of other channels. No cross-channel chat archive, web browsing or attachment inspection is performed by Community.
- Conversation work expires two minutes after its source. Replies contain at most 2,000 characters and suppress mentions. Edits/deletions of the source or selected context messages invalidate pending work; they do not replace retained original moderation evidence. Missing Message Content intent or history permission limits context. Names inside code or blockquotes do not trigger replies.
- Starter payload/metadata/evidence/accounting retention is 1/7/30/30 days. The bot runs bounded cleanup even while ordinary work is paused. Memory and Debate retain their separately consented, bounded lifetimes. Expiry blocks disclosure immediately; maintenance physically erases later.
- Resolved Community/Jobs/Intake metadata and expired audit records have cleanup paths. Minimal knowledge lineage, memory deletion/consent receipts, Debate consent/publication metadata and unresolved external/accounting evidence can remain with explicit retained dispositions. A removal acknowledgment is not a promise that every identifier disappeared.
- Local erasure cannot delete content already received by providers or Discord, including private command responses/attachments and published messages. Moderation evidence is independently owned; forgetting Memory does not erase it.
- PostgreSQL notifications reduce queue delay, and periodic scans recover missed wakeups. Source observation gaps on reconnect/restart invalidate pending work. Ambiguous Discord sends stay unknown until exact bot/channel/nonce/hash or audit attribution proves an outcome.
- Use `npm run health` for a bounded database, ownership and workflow snapshot. Conversation latency logs contain bounded timings and internal IDs, not message bodies. Increase `WORKER_CONCURRENCY` from 1 only after checking queue wait and provider failures; limits still apply across lanes.

## Troubleshooting and verification

| Symptom | Check |
| --- | --- |
| Database preparation fails | Correct database owner/role-creation authority, passwords, migration checksums and compatible prior schema. Do not run runtime processes with the admin URL. |
| Bot is online but `/yuna` is absent/stale | Correct application ID/server, Guild Install command scope, and rerun `npm run register:commands`. |
| Commands report unavailable on startup | Wait for readiness; check the ownership lock, Gateway permissions and process logs. |
| Configured policy awaits approval | Current owner runs bootstrap if needed, then configure. Confirm bot model selectors match the worker. |
| No conversation reply | Both processes live; standalone Yuna name, actual mention or reply trigger, channel `direct`, current source, matching model, native send/history permissions and remaining usage. |
| Moderation remains incomplete/uncertain | Original capture/access, declared evidence requirements, current published policy, matching observation/assessment models and enabled Jev route. Missing evidence never becomes a violation. |
| A staff ban was accepted but did not happen | Inspect action state, current grant/native permission, role hierarchy and retained evidence. An unknown result is not safely retriable. |
| Monetary work does not start | Verified exact-route prices, token ceilings, currency compatibility and prior unknown liabilities. Budgeted templates deliberately ship without invented prices. |
| Debate cannot start or publish | Both exact-scope consents, matching `JEV_MODEL`, enabled feature, unexpired transcript, quotas and an ordinary text/announcement destination with current permissions. |
| Shutdown reports lost ownership | The bot's dedicated database lock connection was lost. Resolve that connection failure and restart one bot process. |

Run `npm run typecheck`, `npm run check:docs`, and `npm test` for offline source/unit checks. `npm run test:all` additionally uses private temporary PostgreSQL clusters with mocked providers/Discord. Run PostgreSQL suites serially; they do not use production credentials or spend API credit. Automated tests do not establish that your actual server permissions, model account or live billing are configured correctly.
