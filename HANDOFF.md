# Handoff

## Snapshot

Last verified: 2026-09-19 (Asia/Calcutta)

Project path: `D:\telepc\telegram-link-bot`

| Item | State |
| --- | --- |
| Worker name | `telegram-link-bot` |
| Worker URL | <https://telegram-link-bot.pcbot.workers.dev> |
| Cloudflare authentication | Authenticated according to project handoff |
| Source | Phase 1/6 intake plus local TinyFish/Gemini Queue processor in `src/index.js`, `src/page-reader.js`, `src/gemini.js`, and `src/processor.js` |
| Current response | `/health` returns JSON; `/telegram` validates the webhook secret and extracts normalized URLs |
| Tests | 22 Phase 1/6/7/8/9 tests pass with `npm test -- --run`; latest bundle also passes Wrangler dry-run |
| Phase 2 deployment | Complete: deployed and `/health` verified at the public Worker URL |
| D1 | Created in APAC, bound as `DB`, migration `0001_initial.sql` applied and verified remotely |
| Work Queue | Created as `telegram-link-jobs`; producer/consumer/DLQ config deployed |
| Dead-letter Queue | Created as `telegram-link-jobs-dlq` |
| Cloudflare secrets | `TELEGRAM_WEBHOOK_SECRET`, `TINYFISH_API_KEY`, `GEMINI_API_KEY`, optional `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_CHAT_IDS` |
| Telegram webhook | Worker webhook registered at `/telegram`; first end-to-end job completed |
| Telegram test context | Group chat; bot privacy mode off; bot is admin; user is group owner |
| Existing Apps Script bot | Active/untouched; must remain so during migration testing |
| Intended GitHub repo | <https://github.com/roso1102/pcbot.git> |
| Local Git remote | No remote configured at handoff time |

Phase 1 application code and tests were added and deployed. Wrangler dry-run passed with no bindings, and the public `/health` endpoint returned `ok: true` with service `telegram-link-bot`. The webhook secret was configured and a synthetic `/telegram` intake test passed. D1 `telegram-link-bot-db` was created in APAC, migration `0001_initial.sql` was applied remotely, and `jobs`/`errors` were verified. No production webhook or Apps Script changes were made.

Both Queues now exist remotely. `wrangler.jsonc` has a `JOBS_QUEUE` producer binding and a consumer configured for three retries with `telegram-link-jobs-dlq` as its dead-letter queue. The deployed Worker currently has the temporary consumer guard. Local Phase 6 code now persists and publishes jobs, but it has not been deployed yet; deploy it only with the understanding that the consumer still retries until the extraction processor is implemented.

The local provider layer is in `src/page-reader.js`: TinyFish Fetch is primary, Firecrawl is optional fallback only when its key exists, and content is normalized before model extraction. It strips common LinkedIn UI lines and repairs common UTF-8 mojibake. `src/processor.js` reads the D1 job, calls Gemini first, falls back to Groq when `GROQ_API_KEY` is configured and Gemini fails, persists structured output, records the original provider error, and sends Telegram success/failure status when `TELEGRAM_BOT_TOKEN` is configured. The latest local success message identifies the extractor used. Group UX sends one queued progress message and edits it through reading, extraction, fallback, and final/error states; the queue payload carries its Telegram message ID for redelivery-safe edits.

The local intake now avoids publishing a second Queue message when a duplicate job is already `queued` or `processing`, and schedules a Telegram “already saved or in progress” message for duplicates. This fix requires deployment before verification; Google Sheets row numbers will be added during Phase 9.

With Telegram privacy mode off, the bot can receive all group messages. Intake still ignores messages without supported HTTP(S) URLs. The old Apps Script webhook was removed and the Worker webhook was reported registered; verify one end-to-end job before treating cutover as complete.

## Start here

The next implementer should continue Phase 7/8 processor work:

1. Inspect the completed job's `result_json` and Telegram status message.
2. Run duplicate, blocked-page, provider-rate-limit, and Queue/DLQ tests.
3. Begin Google Sheets persistence only after those failure gates pass; Calendar/reminders are deferred.
4. Keep the current Worker webhook active, but retain Apps Script rollback information until the observation period ends.

Read [README.md](./README.md) for architecture and operating rules and [ACTION_PLAN.md](./ACTION_PLAN.md) for phase gates.

## First-session checklist

- [ ] Run `git status --short` and preserve any user changes.
- [ ] Inspect `src/index.js`, `test/index.spec.js`, `wrangler.jsonc`, and `package.json`.
- [ ] Run the baseline `npm test` before editing.
- [ ] Verify Cloudflare identity with `npx wrangler whoami` before any remote mutation.
- [ ] Verify `https://telegram-link-bot.pcbot.workers.dev` is the intended Worker.
- [ ] Confirm the local checkout belongs to `roso1102/pcbot` before configuring/pushing `origin`.
- [ ] Work on a feature branch; do not push credentials or generated `.wrangler` contents.
- [ ] Keep the Apps Script project and the live Telegram webhook out of scope.

## Phase 1 implementation notes

Keep routing small and testable. A suggested initial behavior is:

| Request | Expected result |
| --- | --- |
| `GET /health` | `200` JSON with `{ ok: true, service: "telegram-link-bot" }` |
| `POST /telegram` with correct secret and supported fixture | Safe `200` acknowledgement |
| `POST /telegram` without/wrong secret | `401` or `403`, with no secret in body/logs |
| `POST /telegram` with malformed JSON | `400` |
| Wrong method on a known route | `405` and an `Allow` header |
| Unknown path | `404` |

Until D1 and Queue exist, `/telegram` should not claim that a URL was durably queued. It may acknowledge a test fixture or return a clear temporary status. Do not introduce an in-memory deduplication scheme; it will not be durable across Worker isolates.

For header comparison, use a timing-safe approach where practical and never log the received or expected webhook secret. Limit request size before parsing.

## Resource creation checkpoint

Do not execute these commands during route-only work. They are recorded for the later approved phases:

```powershell
npx wrangler d1 create telegram-link-bot-db --binding DB --update-config
npx wrangler queues create telegram-link-jobs
npx wrangler queues create telegram-link-jobs-dlq
```

After creation, capture the generated D1 binding/config in `wrangler.jsonc`, configure Queue producer/consumer/DLQ settings, and review the diff. Resource identifiers are safe to commit; credentials are not.

Suggested resource/binding names:

- D1 database: `telegram-link-bot-db`
- D1 binding: `DB`
- Work Queue: `telegram-link-jobs`
- Producer binding: `JOBS_QUEUE`
- Dead-letter Queue: `telegram-link-jobs-dlq`

## Secrets checkpoint

Expected names (validate against code before creating them):

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TINYFISH_API_KEY`
- optionally `FIRECRAWL_API_KEY` (fallback disabled when absent)
- `GEMINI_API_KEY`
- optionally `GROQ_API_KEY` for model fallback
- `GOOGLE_SHEETS_BRIDGE_URL`
- `GOOGLE_SHEETS_BRIDGE_SECRET`
- `TELEGRAM_ALLOWED_CHAT_IDS`

Enter production values only through interactive `npx wrangler secret put NAME`. Keep local values in ignored `.dev.vars`. Never paste real values into this file, `wrangler.jsonc`, source, tests, shell arguments, GitHub discussions, or logs.

If a secret is exposed, stop using it, rotate/revoke it at the provider, audit access, and remove it from Git history through an explicitly coordinated incident response. Merely deleting it in a later commit is insufficient.

## GitHub handoff

The intended remote is known, but the current local repository has no configured remote. Verify before changing repository configuration:

```powershell
git remote -v
git status --short
git log -5 --oneline
```

Once repository ownership/history are confirmed:

```powershell
git remote add origin https://github.com/roso1102/pcbot.git
git fetch origin
git switch -c feat/health-telegram-routes
```

If histories differ, stop and reconcile deliberately; do not force-push, reset, or overwrite either history. Use pull requests with passing `npm test` and `npx wrangler deploy --dry-run`. PR descriptions should list new bindings/secrets by name only, acceptance evidence, deployment steps, and rollback impact.

## Migration invariants

These are non-negotiable until the migration has passed:

- [ ] Do not modify or delete the existing Apps Script deployment.
- [ ] Do not point the production Telegram webhook at the Worker before phases 1–10 pass.
- [ ] Do not test the production Sheet until idempotency is implemented; use a test Sheet target. Do not configure Calendar yet.

The local Sheets implementation is in `src/google-sheets.js`, and the separate Apps Script bridge template is in `google-sheets-bridge/Code.gs`. Apply all pending migrations, including `0004_lifecycle_actions.sql`, before deploying it. Set Apps Script properties `SHEET_TAB=Links`, `STATUS_TAB=Status`, `FAILURES_TAB=Failures`, `ARCHIVE_TAB=Archive`, and `WORKER_ACTION_URL=https://telegram-link-bot.pcbot.workers.dev/sheet-action`. The bridge stores the Sheet ID and shared secret in Apps Script properties, writes the compact main data tab, automatically creates the two support tabs, preserves a legacy wide `Sheet1` when detected, and runs the installable `handleSheetActionEdit` trigger after `installSheetActionTrigger()` is run once. `Save edits` synchronizes title, summary, user note, type, deadline, and tags into D1 `result_json`; it does not re-run extraction. The Worker stores only the bridge URL and matching secret.
- [ ] Do not perform page/model/Google work synchronously in the Telegram webhook.
- [ ] Do not acknowledge durable acceptance before the D1/Queue handoff has succeeded or is recoverable.
- [ ] Do not assume exactly-once Queue delivery; every downstream operation must be idempotent.
- [ ] Do not log secrets, auth headers, full service-account JSON, or raw private content.
- [ ] Do not delete failed job evidence during recovery; record state and reconcile it.

## Before webhook cutover

- [ ] Record the current webhook target and a tested rollback procedure in a secure operator runbook.
- [ ] Confirm D1 migrations and indexes are applied remotely.
- [ ] Confirm Queue retries and DLQ routing with an intentional failure.
- [ ] Confirm duplicate Telegram updates and equivalent URLs do not duplicate work.
- [ ] Confirm TinyFish bounded retry behavior and Firecrawl fallback behavior when enabled.
- [ ] Confirm Gemini schema validation blocks malformed output.
- [ ] Confirm Google writes reconcile correctly after partial failure.
- [ ] Confirm Sheet `Archive` and `Delete` actions update D1 before changing the visible row.
- [ ] Confirm status messages are useful and do not expose internals.
- [ ] Review production logs for redaction.
- [ ] Obtain explicit cutover approval.

The webhook target after approval will be:

```text
https://telegram-link-bot.pcbot.workers.dev/telegram
```

Keep the Apps Script deployment available throughout the observation period so rollback is quick and does not require reconstructing the old system.
