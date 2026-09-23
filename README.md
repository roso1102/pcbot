# Telegram Link Bot

A Cloudflare Workers Telegram bot that accepts URLs, rejects duplicate submissions, processes work asynchronously, extracts structured data, writes results to Google Sheets, and reports progress back to Telegram. Calendar events and reminders are deliberately deferred until Sheet persistence is reliable.

> Migration safety: the existing Apps Script code remains available for rollback. The Worker webhook is now active; keep the rollback procedure until the observation period and failure tests are complete.

## Current status

- Worker: `telegram-link-bot`
- Deployed URL: <https://telegram-link-bot.pcbot.workers.dev>
- Cloudflare authentication: available
- Cloudflare Worker: deployed; `/health` verified
- Telegram webhook: connected to this Worker; the old Apps Script webhook was removed
- D1 database: created and schema applied remotely
- Cloudflare Queues: main and dead-letter queues created
- Existing Apps Script bot: code remains untouched for rollback, but its webhook is no longer active
- Intended GitHub repository: <https://github.com/roso1102/pcbot.git>
- Current phase: Phase 12 baseline/hardening complete; hosted multi-workspace phases are intentionally paused pending owner approval

Phases 1–12 have passed the current single-user migration and hardening gates. Phase 12 added protected DLQ inspection/replay, deduplicated stuck-job alerts, scheduled retention, a D1 restore rehearsal, and operational tests. Hosted multi-workspace work remains paused until the owner explicitly approves it. See [ACTION_PLAN.md](./ACTION_PLAN.md) for the phase gate and [HANDOFF.md](./HANDOFF.md) for the continuation point.

## Target architecture

```text
Telegram
   |
   | POST /telegram (validated webhook secret)
   v
Cloudflare Worker
   |-- normalize URL and create idempotency key
   |-- write job to D1
   |-- enqueue job
   `-- reply/acknowledge quickly
          |
          v
   Cloudflare Queue consumer
          |
          |-- TinyFish Fetch page reader (Firecrawl optional fallback)
          |-- Groq structured extraction (GPT-OSS 120B)
          |-- Gemini retained only as an explicit opt-in provider
          |-- Google Sheets persistence (Links / Status / Failures / Archive)
          |-- Calendar/reminder module (future, deferred)
          |-- D1 status/error update
          `-- Telegram status message

Failed deliveries -> dead-letter queue -> observable/manual recovery
```

The Telegram request path must stay fast. Page reading, model calls, and Google API writes belong in the Queue consumer, not in the webhook request.

## Planned routes

### `GET /health`

Returns a small JSON response without exposing configuration or secret values.

Example:

```json
{
  "ok": true,
  "service": "telegram-link-bot"
}
```

Acceptance criteria:

- [ ] Returns HTTP `200` and `content-type: application/json`.
- [ ] Includes a stable service identifier and health boolean.
- [ ] Does not call external services or reveal environment variables.
- [ ] All unsupported routes return `404`.

### `POST /telegram`

Receives Telegram updates. Before the webhook switch, test it with representative fixture payloads or a separate test bot/token.

Acceptance criteria:

- [ ] Rejects non-`POST` requests with `405`.
- [ ] Verifies Telegram's `X-Telegram-Bot-Api-Secret-Token` header using `TELEGRAM_WEBHOOK_SECRET`.
- [ ] Rejects invalid authentication without logging the supplied token.
- [ ] Handles Telegram retries idempotently by `update_id`.
- [ ] Accepts only configured chats/users when an allowlist is enabled.
- [ ] Extracts and normalizes HTTP(S) URLs; unsupported messages receive a useful response.
- [ ] Writes a job record and publishes a Queue message at most once.
- [ ] Acknowledges Telegram promptly; slow work happens asynchronously.

## Planned bindings and configuration

Use bindings for Cloudflare resources and secrets for credentials. Names below are proposed defaults and should remain consistent in code, `wrangler.jsonc`, migrations, and runbooks.

| Purpose | Proposed name | Kind |
| --- | --- | --- |
| D1 database | `telegram-link-bot-db` | Cloudflare resource |
| D1 binding | `DB` | Worker binding |
| Work queue | `telegram-link-jobs` | Cloudflare Queue |
| Producer binding | `JOBS_QUEUE` | Worker binding |
| Dead-letter queue | `telegram-link-jobs-dlq` | Cloudflare Queue |
| Telegram bot token | `TELEGRAM_BOT_TOKEN` | Secret |
| Telegram webhook validation | `TELEGRAM_WEBHOOK_SECRET` | Secret |
| TinyFish authorization | `TINYFISH_API_KEY` | Secret |
| Firecrawl authorization | `FIRECRAWL_API_KEY` | Optional secret; disabled when absent |
| Gemini authorization | `GEMINI_API_KEY` | Secret |
| Extraction provider | `EXTRACTION_PROVIDER` | Worker variable; defaults to `groq`; set to `gemini` only to opt back in |
| Groq authorization | `GROQ_API_KEY` | Secret; used for primary extraction |
| Groq model | `GROQ_MODEL` | Worker variable; `openai/gpt-oss-120b` (strict JSON Schema mode) |
| Sheets bridge URL | `GOOGLE_SHEETS_BRIDGE_URL` | Secret or non-secret variable |
| Sheets bridge secret | `GOOGLE_SHEETS_BRIDGE_SECRET` | Secret |
| Sheet action endpoint | `POST /sheet-action` | HMAC-signed Apps Script requests |
| Target calendar | Not configured yet | Deferred future feature |
| Telegram allowlist | `TELEGRAM_ALLOWED_CHAT_IDS` | Secret or non-secret variable |
| Operations admin authentication | `ADMIN_API_SECRET` | Secret; required for `/admin/*` routes |
| Operations alert recipients | `TELEGRAM_ADMIN_CHAT_IDS` | Secret or non-secret variable; comma-separated chat IDs |

Do not add placeholder bindings to `wrangler.jsonc` until the matching resources exist and their generated identifiers are known.

## Local development

Prerequisites:

- Node.js and npm
- A Cloudflare account authenticated through Wrangler
- Access to the external service credentials needed for the current phase

Install and run:

```powershell
npm ci
npm test
npm run dev
```

Test the health route once it exists:

```powershell
Invoke-RestMethod http://localhost:8787/health
```

Use `.dev.vars` for local-only secrets. Commit only a redacted `.dev.vars.example` that contains names, never real values.

Phase 12 setup after local tests pass:

```powershell
npx wrangler d1 migrations apply telegram-link-bot-db --remote
npx wrangler secret put ADMIN_API_SECRET
# Optional alerts: npx wrangler secret put TELEGRAM_ADMIN_CHAT_IDS
npm run deploy
```

The protected operations routes are `GET /admin/dlq`, `GET /admin/stuck`, `POST /admin/dlq/replay`, and `POST /admin/retention`. Send the admin secret in `X-Admin-Secret`; send a short operator identity in `X-Admin-Actor`. Retention defaults are 90 days for raw Telegram text, 365 days for structured results, 180 days for errors, and 730 days for audit records. A retention request with `{ "dryRun": true }` reports the configured actions without changing data.

## Deployment

From `D:\telepc\telegram-link-bot`:

```powershell
npm test
npm run deploy
Invoke-RestMethod https://telegram-link-bot.pcbot.workers.dev/health
```

Inspect production logs without printing request authorization headers or environment values:

```powershell
npx wrangler tail telegram-link-bot
```

The `Links` and `Archive` tabs include an `action` dropdown. Selecting `Save edits` validates and writes title, summary, user note, type, deadline, and tags into the canonical D1 JSON. Selecting `Archive`, `Restore`, or `Delete` calls the signed `/sheet-action` endpoint first; rows move or disappear only after D1 confirms the action. Set Apps Script properties `WORKER_ACTION_URL=https://telegram-link-bot.pcbot.workers.dev/sheet-action` and `ARCHIVE_TAB=Archive`, then run `installSheetActionTrigger()` once in the bridge editor.

Every deployment should have a recorded commit SHA and a short smoke-test result in its pull request or release notes.

## Secret-safety rules

- [ ] Never commit tokens, API keys, private keys, service-account JSON, webhook secrets, OAuth refresh tokens, or copied request headers.
- [ ] Set production credentials with `npx wrangler secret put SECRET_NAME`; paste the value only at Wrangler's prompt.
- [ ] Keep local credentials in ignored `.dev.vars` or `.env` files; never put them in `wrangler.jsonc`.
- [ ] Example files contain variable names and obviously fake placeholders only.
- [ ] Never pass a secret value directly on a shell command line, where it can enter history or process listings.
- [ ] Logs may contain job IDs, Telegram `update_id`, status, durations, and provider HTTP status codes, but not message bodies containing sensitive data or credential values.
- [ ] Store the minimum Telegram/Google data required and document retention/deletion behavior before production use.
- [ ] Rotate a credential immediately if it is exposed; remove it from Git history as a separate incident-response task.
- [ ] Use separate test and production bot credentials whenever possible.
- [ ] Keep the separate Apps Script bridge restricted to the specific Sheet it needs. Add Calendar access only if the deferred feature is later approved.
- [ ] Treat fetched page content and model output as untrusted input; never interpret them as commands or configuration.

Before each commit, run:

```powershell
git diff --check
git diff --staged
git status --short
```

## GitHub workflow

The repository is intended to live at <https://github.com/roso1102/pcbot.git>, but the local checkout currently has no remote. Verify the repository identity before adding it:

```powershell
git remote -v
git remote add origin https://github.com/roso1102/pcbot.git
git fetch origin
```

If `origin` already exists in a future checkout, update it only after verifying the old value:

```powershell
git remote get-url origin
git remote set-url origin https://github.com/roso1102/pcbot.git
```

Development flow:

1. Sync the default branch and create a focused branch such as `feat/health-telegram-routes`.
2. Make one reviewable phase of changes; include or update tests and documentation.
3. Run `npm test` and a local smoke test.
4. Review `git diff` for accidental credentials and unrelated generated files.
5. Commit with a focused message, for example `feat: add health and telegram intake routes`.
6. Push the branch and open a pull request against the default branch.
7. In the pull request, record acceptance criteria, test output, deployment impact, rollback steps, and any new bindings/secrets by name only.
8. Require passing CI and review before merge. Do not put secret values in issues, commits, CI logs, or pull-request descriptions.
9. Deploy from the reviewed commit, then record the production health check.

Suggested minimum CI checks are `npm ci`, `npm test`, and `npx wrangler deploy --dry-run`. Production deployment should use protected GitHub environments/secrets or an explicitly approved manual Wrangler deployment.

## Migration guardrail

The final webhook cutover is intentionally last. Before it:

- [ ] The Worker is deployed and healthy.
- [ ] Intake tests pass without using the production webhook.
- [ ] D1 and Queue/DLQ behavior is proven.
- [ ] TinyFish/Firecrawl and Groq errors/rate limits are tested.
- [ ] Google writes are idempotent and verified in test destinations.
- [ ] Telegram success and failure notifications are verified.
- [ ] Duplicate updates, duplicate URLs, rate limits, timeouts, malformed content, and blocked pages are tested.
- [ ] The current Telegram webhook target is recorded for rollback.
- [ ] A rollback command and responsible operator are agreed upon.

Only then should the Telegram webhook be switched to `https://telegram-link-bot.pcbot.workers.dev/telegram`. Keep the Apps Script deployment intact until the new Worker has completed an agreed observation period.
