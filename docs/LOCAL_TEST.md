# Run Yuna on this Mac

This first milestone supports text conversation in **one configured Discord server**, in every channel Yuna can read and send to. Mention Yuna or reply to her message, including with the reply ping turned off. Ordinary messages, DMs, other bots and webhooks are ignored. Moderation, Jev decisions, personal memory and debates are not enabled.

## 1. Prepare the local tools and database

Use Node.js 24 or newer and PostgreSQL 17 or newer. Dependencies are locked:

```sh
cd /Users/krishnamonidas/Documents/Yuna
npm ci
```

If you already have local PostgreSQL running, use it and create a new empty `yuna` database owned by your administrative PostgreSQL user. Otherwise, with Homebrew installed:

```sh
brew install postgresql@17
brew services start postgresql@17
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
createdb yuna
```

The default Homebrew administrator is normally your Mac login username; `whoami` shows that name. Use your actual PostgreSQL account if your installation differs. Keep this database local. The setup command below needs database ownership and permission to create login roles. It deliberately refuses elevated runtime roles and incompatible pre-existing schemas. [Homebrew PostgreSQL instructions](https://formulae.brew.sh/formula/postgresql@17).

## 2. Create and invite the Discord bot

Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application named Yuna, then:

1. On **Bot**, obtain/reset the bot token and enable **Message Content Intent**. Save the token locally in the next step.
2. On **Installation**, enable **Guild Install**. Add the `bot` scope and these bot permissions: **View Channels**, **Send Messages**, **Read Message History**, and **Send Messages in Threads** if testing threads.
3. Open the installation link and add Yuna to your server. Channel overrides must allow the same permissions. Private threads also require access; archived/locked threads may reject replies.
4. In Discord's **User Settings → Advanced**, enable Developer Mode. Right-click your server and copy its **Server ID**.

No Administrator permission, slash command registration, public web server or tunnel is needed for this milestone. The app connects through Discord's Gateway. [Discord application setup](https://docs.discord.com/developers/quick-start/getting-started), [Gateway intents](https://docs.discord.com/developers/events/gateway#gateway-intents).

## 3. Fill the three local environment files

Run these copies only when the destination files do not already exist:

```sh
cp -n .env.admin.example .env.admin
cp -n .env.bot.example .env.bot
cp -n .env.worker.example .env.worker
chmod 600 .env.admin .env.bot .env.worker
```

Edit them locally; do not paste keys or passwords into chat.

| File | Values to fill |
| --- | --- |
| `.env.admin` | `ADMIN_DATABASE_URL` with your database owner's username; distinct `BOT_DATABASE_PASSWORD` and `WORKER_DATABASE_PASSWORD`. |
| `.env.bot` | The matching bot database password in `BOT_DATABASE_URL`, `DISCORD_BOT_TOKEN`, and `DISCORD_GUILD_ID`. Keep `REPLY_MODEL=fake` for the first connection test. |
| `.env.worker` | The matching worker database password in `WORKER_DATABASE_URL`. Keep `DEEPSEEK_MODE=fake` and `JEV_MODE=disabled` initially. |

Use long random passwords. Hexadecimal passwords are easy to place in URLs; otherwise percent-encode special characters in the two database URLs. The admin file contains raw password values, quoted when needed for Node's environment-file syntax. The files are ignored by Git. Do not give the admin URL or Discord token to the worker.

Prepare the database once:

```sh
npm run db:prepare
```

Success prints migration status and the role names. Re-running verifies migration checksums and reapplies the restricted grants/password settings; it preserves existing data. The bot gets only conversation-related tables; the worker gets only specific task functions. Startup never creates a database or applies migrations.

## 4. Start both processes and test a free reply

The setup command built the project. Open two terminals in this project folder:

```sh
# Terminal 1
npm run local:worker
```

```sh
# Terminal 2
npm run local:bot
```

Wait for `ai-worker: ready.` and `bot: ready.`. In a permitted channel, send **@Yuna hello** using Discord's actual mention picker. The worker should produce a clearly labeled fake response. Reply to it with the mention toggle off to verify reply detection. Check another readable channel as well.

Keep both terminals running and the Mac awake. Ctrl+C stops each process. After editing code, stop both processes, run `npm run build`, then restart them.

## 5. Enable real DeepSeek conversation

Stop both processes. In `.env.worker`, set:

```dotenv
DEEPSEEK_MODE=live
DEEPSEEK_API_KEY=your-key-here
DEEPSEEK_MODEL=deepseek-flash
JEV_MODE=disabled
```

In `.env.bot`, set `REPLY_MODEL=deepseek-flash`, then start both processes again. Keep the two model strings identical. `deepseek-flash` is the current documented Flash model identifier as of 21 October 2026; another supported text model can be chosen explicitly. The adapter uses the direct DeepSeek chat endpoint with thinking disabled, a 512-token output limit, and no tools or automatic retries. [DeepSeek API documentation](https://api-docs.deepseek.com/).

For the planned Jev decision adapter, set `JEV_MODEL=typesafe/jev-1.14` and use `OPENROUTER_API_KEY` in `.env.worker`. Keep `JEV_MODE=disabled`: adding the key/model alone does not enable classification. This pinned OpenRouter model ID was verified on 21 October 2026 against [OpenRouter's Jev documentation](https://openrouter.ai/docs/guides/community/jev). Jev's structured classification/decision work remains the next separately scoped integration.

## Pilot behavior and limits

- Maximum **20 claimed generation attempts per UTC day per server**, including fake/failed attempts; restarting does not reset it. At most 20 requests can be pending. This limits calls, **not dollar spending**; provider pricing and billing remain authoritative.
- Input is the current text (up to 4,000 characters), plus only the replied-to Yuna message (up to 2,000). No channel archive, attachments, browsing or personal memory is loaded. Replies are at most 2,000 characters and do not ping users/roles/everyone.
- Work expires two minutes after the source message. Provider timeout defaults to 30 seconds. Edit/delete before dispatch cancels the reply; editing does not start a new request. Send a new mention to retry intentionally.
- Disconnections and bot restarts invalidate pending work because edits/deletions may have been missed. An already sent reply cannot be recalled by cancellation. Ambiguous sends are never automatically resent; only exact attributable Discord evidence can reconcile them.
- Stored input/output payloads are cleared after 24 hours by maintenance while the bot runs. If stopped, cleanup resumes on startup. Technical IDs, hashes, usage and deduplication metadata remain; complete metadata deletion is a later maintenance feature. Discord messages and DeepSeek's own retention are outside this local cleanup.
- Use one bot instance and the default single worker lane for the first test. This is a local pilot, not a production moderation or load-tested service.

## If it does not reply

| Symptom | Check |
| --- | --- |
| Database preparation fails | Database exists and is empty on first setup; admin URL points to its owner; owner can create roles; both passwords are filled. The migration runner refuses unsafe existing roles/checksum drift. |
| Worker startup fails | Run `db:prepare`; check worker URL/password and that `JEV_MODE=disabled`. |
| Bot startup fails or closes | Bot token, invited server ID, PostgreSQL URL and Message Content Intent in the Portal. |
| Online, but no reply | Both processes are running; real mention/reply trigger; matching model strings; View/Send/History permissions; source is recent and unchanged. Ordinary messages and other servers are intentionally ignored. |
| Reply stopped after many tests | The 20-attempt UTC-day limit includes fake and unsuccessful claims. Wait until the next UTC day; restarting does not clear it. |
| `generation ended (authentication)` / `(insufficient_balance)` | Fix the key or DeepSeek account balance locally; send a new mention. |
| `generation ended (rate_limited)` / `(timeout)` | Provider could not finish this attempt. There is no automatic retry; send a new mention when ready. |
| A request disappeared during restart/edit | Expected for pending work. Send a new mention after both processes are ready. |

Automated verification: `npm run test:all` uses private temporary PostgreSQL clusters and mocked Discord/provider calls. It does not use your server, bot token or API credit. A real Discord/DeepSeek round trip still requires your local credentials and the manual checks above.
