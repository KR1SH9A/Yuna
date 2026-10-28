# Configure Yuna

This folder contains starter policies, not credentials. Copy a template to `config/yuna.json`, set `YUNA_CONFIG_FILE=config/yuna.json` in `.env.bot`, then apply it with `/yuna configure` after `/yuna bootstrap`. Configuration changes are authorized, validated and saved as revisions. Editing a file alone does not silently change the running server policy.

| Template | Initial behavior |
| --- | --- |
| `yuna.example.json` | Four text moderation rules, warnings for established violations, ten daily member-requested provider attempts per member and 1,000 total provider attempts per server. No monetary cap is promised. |
| `yuna.budgeted.example.json` | The same rules, plus a $5.00 server budget and $0.50 member budget per UTC day. Add verified prices before live calls can run. |

The starter enables Memory and Debates as available commands. Each member still has to consent. Moderation evaluates original text for harassment, threats, privacy violations and scams. Quotation/reporting/educational context is excluded when the conduct is not endorsed. Unclear evidence produces uncertainty. The starter never bans or deletes message history; owners can explicitly change the action mappings later.

JSON does not support comments. This guide explains each section, and the TypeScript configuration contract documents its constraints.

## Debate rubric example

[debate-rubric.example.json](debate-rubric.example.json) is an editable example included with Yuna's source. It gives equal weight to connected reasoning and fair engagement with the other participant's argument, with three explicit score levels per criterion. It is illustrative, not a claim of scoring accuracy or a universal standard of debate quality. Both participants review and consent to the complete selected rubric before any assessment.

Paste the file's complete JSON into `/yuna debate propose` as the `rubric` option, or use the compact ready-to-paste form in [local setup](../docs/LOCAL_TEST.md#consented-debates). The example is below the command's 4,000-character bound and passes the same runtime rubric validator as a user proposal. You can change criteria, levels, weights and uncertainty thresholds before proposing a new session; an accepted session keeps its frozen rubric. The file is a proposal aid, not an automatically applied server policy.

## Models and credentials

The rules contain no model-specific behavior. `env:REPLY_MODEL` and `env:JEV_MODEL` resolve to the selected model names in the bot's environment. Set the same observation/reply and assessment model names in the worker's environment. These two exact selectors are the only environment substitutions; Yuna never expands arbitrary strings or reads secrets from a policy.

The current adapters support the configured DeepSeek chat interface and OpenRouter Decisions interface. A model must support the selected interface; changing a model name does not create support for a different provider protocol. Use `REPLY_MODEL=fake`, `JEV_MODEL=fake`, `DEEPSEEK_MODE=fake` and `JEV_MODE=fake` for an offline rehearsal. Fake assessments remain uncertain and cannot authorize sanctions.

Keep Discord, database and provider credentials in their role-specific `.env` files. Do not commit those local files. See `.env.bot.example` and `.env.worker.example` for the environment settings.

## Usage and spending

- `usage.dailyAttemptLimit`: server allowance for provider attempts across features and providers. Accepted work from earlier installation generations still counts. The window resets at 00:00 UTC.
- `usage.userDefaults.dailyAttemptLimit`: allowance for each member's requested conversations and initiated debate assessments. A value of zero stops new personal claims. A debate's initiator owns its assessment usage; both participants consent before scoring. Moderation costs belong to the server, not the person being reported.
- `dailyBudget`: exact decimal `amount` plus three-letter `currency`, or `null` for no monetary cap at that level. Decimal values are strings to preserve sub-cent amounts.
- `prices`: a versioned entry for each provider/model route. Supply its current input/output prices per million tokens and conservative token ceilings. The current bounded routes require at least 65,536 input tokens for moderation and 32,768 for conversation; use 65,536 input and 4,096 output as a shared conservative ceiling. Higher reservations reduce available capacity but avoid underestimating a call.

A price entry has this shape; replace every placeholder with the actual selected route and verified price:

```json
{
  "provider": "deepseek",
  "model": "your-selected-model",
  "version": "your-price-schedule-date",
  "currency": "USD",
  "inputPerMillion": "REPLACE_WITH_VERIFIED_DECIMAL",
  "outputPerMillion": "REPLACE_WITH_VERIFIED_DECIMAL",
  "maxInputTokens": 65536,
  "maxOutputTokens": 4096
}
```

Use `openrouter` for the assessment route. OpenRouter-reported costs are USD; Yuna does not invent exchange rates. Keep every active route and configured cap in the same currency. A capped route with no usable price is blocked before provider disclosure. Previously unresolved unpriced work also blocks a newly enabled monetary cap until it no longer belongs to the current day or trustworthy accounting resolves it.

Yuna reserves the conservative maximum before dispatch. Known token usage settles at the admitted price snapshot; exact reported assessment cost replaces the estimate. Timeouts retain the reservation because a provider may have charged for the call. Limits apply to newly claimed calls and do not recall work already dispatched. Use provider-account limits too if you need a limit that also covers other applications using the same account.

Members can use `/yuna usage` to inspect their own quota and accounting, `/yuna limit` to set a personal request or spending limit, and `/yuna limit-clear` to return to server defaults. A member cannot raise the server's allowance. Responses are private, and commands never accept another member's identity as the spending subject.

## Moderation policy

`rules` gives each rule a stable ID, version, description and enabled flag. `requiredEvidence` declares whether the original body, media and author must be established. The shipped route inspects text; requiring media makes that case incomplete until a media-inspection capability exists.

`exclusions` describes allowed contexts. `evaluationConfiguration` selects the model bindings, prompt version and explicit confidence/decision thresholds. Model answers are inputs to a deterministic policy; they do not grant permissions or choose Discord operations.

`actionMapping` specifies `none`, `warning` or `ban` for a supported disposition. Suspicion cannot authorize a ban. `deleteMessageSeconds` must be zero for warnings and no more than 604,800 for a ban. Every action preserves its exact rule, evidence and policy references. Unknown delivery or sanction outcomes are reconciled by attribution and are never blindly resent.

## Retention

`payloadDays` controls ordinary conversation payloads, `metadataDays` controls eligible terminal conversation metadata, `evidenceDays` controls moderation evidence, and `accountingDays` controls eligible resolved accounting. Metadata retention must be at least payload retention. Values are whole days from 1 to 3,650.

Payload erasure and financial/effect resolution are separate. An unresolved provider charge or Discord action may retain minimal references after content is erased. Removal runs each owner's cleanup and records any explicit unresolved retention disposition.
