# Action Plan

## Roadmap from 2026-09-24: a hosted bot anyone can join

Goal: a non-technical person opens a setup page, connects Google, adds one shared Telegram bot to a group or starts a private chat, and begins sending links. The operator deploys updates once; users do not run commands, manage Cloudflare, edit Apps Script, or replace secrets. Each person's data and Sheet remain separate.

This roadmap starts from the **working single-user Worker**. The older Phases 1–11 below are a historical migration checklist, not instructions to repeat webhook cutover. Some of their status notes were written before later deployments and are stale. The current code uses TinyFish, Groq GPT-OSS 120B, D1, Queues, a signed Apps Script bridge, and a live Worker webhook. Calendar and reminders remain deferred.

### Product decisions for this roadmap

- [ ] Run one centrally managed Worker, Queue, D1 database, and Telegram bot for the hosted service. Keep staging separate from production.
- [ ] Treat a **workspace** as the isolation and billing/usage boundary. A workspace owns its connected Telegram chats, Google connection, Sheet, jobs, and settings. Start with one owner; add member roles only when collaboration requires them.
- [ ] Use centrally managed TinyFish/Groq credentials initially. Users do not provide provider keys. Track usage per workspace and enforce service limits.
- [ ] Use Google sign-in and a user-authorized Sheet connection for hosted users. Keep the existing Apps Script bridge for the current personal installation during transition.
- [ ] Keep the existing personal bot running independently until a pilot workspace completes the entire flow. Migrate the existing owner's data only with a tested, reversible mapping.
- [ ] Deliver updates through central deployments with versioned database and Sheet migrations. A self-hosted installer can be offered later, but it is not on the path to effortless updates.
- [ ] Decide explicitly before Phase 17 whether edits made directly in Sheets must sync automatically, or whether users will edit/archive/delete through the web app or bot. Google Sheets writes alone do not provide the existing Apps Script `onEdit` behavior.

### Hosted-service definition of done

- [ ] A new person can finish setup without a terminal, Cloudflare account, API key, chat ID, Apps Script editor, or manual webhook command.
- [ ] The person can connect a private chat or a group, connect or create a Sheet, submit a URL, receive progress and a final result, and see exactly one matching Sheet row.
- [ ] Two workspaces can submit the same URL independently without sharing jobs, Sheet rows, errors, settings, or notifications.
- [ ] Connection loss, provider limits, duplicate delivery, retries, and queue replay have understandable outcomes and do not silently lose or duplicate records.
- [ ] Existing personal-bot records, Sheet actions, and webhook continue to work throughout the pilot; a documented migration or continued coexistence is chosen before launch.
- [ ] A production update, migration, staged rollout, and rollback are rehearsed without requiring any end-user action.

### Phase 12 — Baseline and harden the existing bot

Build:

- [x] Record the actual deployed version, Git commit, current D1 schema, queue/DLQ settings, secret names, and Google bridge version. Correct stale status claims in the historical documentation.
- [x] Exercise the current end-to-end flow with a disposable/test Sheet: link intake, duplicate, website/article/grant extraction, Save edits, Archive, Restore, Delete, and a failed-job retry were exercised during migration testing.
- [x] Define a stable job state machine and the source of truth for Sheets versus `jobs.result_json`. Decide how to reconcile a D1 success followed by a Sheet or Telegram failure.
- [x] Implement safe, audited DLQ inspection/replay and alerts for stuck jobs. Ensure a replay cannot create a second Sheet row or notify the wrong chat. The migration is applied and the protected admin path has been exercised.
- [x] Set explicit retention periods for raw Telegram messages, job results, errors, deletion audit records, and logs; implement cleanup only after backup and deletion behavior are tested.
- [x] Capture a baseline for expected latency, provider cost per link, Queue backlog, and typical links per user. On 2026-09-24 D1 contained 22 jobs (18 completed, 4 failed, 0 queued/processing, 0 dead-letter); 20 group links and 1 private link are real traffic plus 1 synthetic test. Recent ordinary completions were typically 17–139 seconds (one 748-second outlier); Queue/stuck backlog was 0. Provider cost is not emitted by the Worker, so provider dashboards remain the cost source of truth for the current low-volume target.

Tests and evidence:

- [x] Unit/integration tests for duplicate Telegram updates, duplicate URLs, concurrent submissions, queue redelivery, provider 429/5xx/timeouts, invalid model output, and partial Sheet writes (51 tests pass).
- [x] Focused Phase 12 tests cover admin authorization, DLQ state marking, replay idempotency, alert deduplication, and retention dry-run behavior (41 tests pass in total).
- [x] Controlled replay of dead-letter job `12686598-ed58-4f54-ab25-392a7f7570a8` was audited and processed once; it ended with the expected TinyFish `empty_content` failure and produced no Sheet row. The job used synthetic chat ID `42`, so its Telegram `400` notification record is expected and not a production-chat failure.
- [x] Real-group replay of job `76c1f375-8715-4da2-acda-1b4fce881cd3` completed successfully after one attempt with provider `tinyfish+groq`, reconciled to Sheet row `12`, and added no new error record.
- [x] Staging test of retry exhaustion into the DLQ and one controlled replay; compare D1 job, Sheet row, and Telegram notifications before/after. The real-group replay completed as `tinyfish+groq` in Sheet row 12 with no new error record.
- [x] Restore a disposable D1 copy and verify a representative job and action history; retain a restore runbook. A remote SQL export was imported into an isolated local D1 persistence directory, the job/replay audit/tables were verified, and the temporary export was removed.
- [x] Run `npm test -- --run`, `npx wrangler deploy --dry-run`, and a live staging smoke test. Current evidence: 51 tests passed and the dry-run exposes the expected D1/Queue/provider bindings.
- [x] Apply and verify `0005_phase12_operations.sql` remotely; deploy the DLQ consumer and 15-minute scheduled operations trigger.
- [x] Live smoke check after deployment: `/health` is healthy; authenticated `/admin/dlq` returned the dead-letter candidate, `/admin/stuck` returned no stuck jobs, and authenticated retention dry-run succeeded.

Exit gate: the current path is reliable enough to serve as a behavior reference, with documented failure recovery and no unexplained duplicate rows.

Phase 12 operating contract:

- `jobs.status` is the durable state machine: `queued` → `processing` → `completed`; retryable failures return to `queued`; terminal failures become `failed`; Queue exhaustion is marked `dead_letter` by the DLQ consumer; an approved replay moves `failed`/`dead_letter` back to `queued` and resets the attempt counter.
- `jobs.result_json` is the canonical structured result. Google Sheets is a user-facing projection and may be reconciled by URL hash/row key. A D1 success remains successful if a secondary Sheet or Telegram notification fails; those secondary failures are recorded and retried independently.
- Phase 12 retention defaults are: raw Telegram message/note 90 days, structured result 365 days, errors 180 days, and deletion/replay audit 730 days. Cleanup redacts or removes only expired data; it does not delete job identity rows, preserving deduplication and auditability. Phase 14 also removes expired OAuth states and old revoked sessions.
- `GET /admin/dlq`, `GET /admin/stuck`, `POST /admin/dlq/replay`, and `POST /admin/retention` require the separate `ADMIN_API_SECRET`. Alerts are deduplicated in D1 and optionally sent to `TELEGRAM_ADMIN_CHAT_IDS`.
- Restore runbook: export with `npx wrangler d1 export telegram-link-bot-db --remote --output <temporary-path> --skip-confirmation`, import only into an isolated local persistence directory with `npx wrangler d1 execute telegram-link-bot-db --local --persist-to <temporary-dir> --file <export> --yes`, verify representative `jobs`, `errors`, `job_replays`, `job_deletions`, and `job_alerts` rows, then remove the temporary export and local directory. Never restore directly over production during this phase.

### Phase 13 — Add workspace ownership without changing current behavior

Build:

- [x] Create versioned D1 migrations for `workspaces`, `users`, `workspace_members`, `telegram_connections`, `google_connections`, and workspace settings. Give the current installation an owner workspace.
- [x] Add `workspace_id` to jobs, errors, deletion audit, and any new status/replay records. Backfill existing records into the owner workspace, validate counts, then make ownership required for new writes.
- [x] Replace global URL uniqueness with workspace-scoped `(workspace_id, canonical_url_hash)` and update idempotency to use the same workspace boundary. Legacy owner storage hashes remain unchanged for Sheet reconciliation.
- [x] Resolve workspace identity from a registered Telegram chat at intake. Queue consumers load ownership from D1 and verify any workspace hint; the hint is never authoritative.
- [x] Put ownership checks on intake, Queue, Sheet keys/actions, status/error/replay records, and owner-scoped admin reads. The legacy bridge remains mapped to the owner workspace.
- [x] Use an additive migration and compatibility fallback so the old Worker remains readable during rollout; no destructive rollback is required.

Tests and evidence:

- [x] Migration tested from a clean six-migration local D1 and then applied remotely; remote verification found 22 preserved jobs, one active owner workspace, three chat connections, and workspace-scoped unique indexes.
- [x] Tests cover two workspaces submitting the same URL with the same Telegram update ID, concurrent/default deduplication, Queue workspace mismatch redelivery, and legacy fallback.
- [x] Cross-workspace Sheet record-key lookup returns `job_not_found`; owner-scoped admin queries and namespaced storage keys prevent metadata crossover.
- [x] Original owner smoke-tested after migration: `/health` is healthy, the Worker is deployed, and existing jobs/chat mappings remain under `workspace_default`.

Exit gate: complete on 2026-09-24. Every migrated record has an owner, new intake/queue/action/operation paths enforce it, and the current personal installation remains usable. Phase 14 may proceed independently from this boundary.

### Phase 14 — Build a simple account and setup page

Build:

- [x] Create a small hosted setup page with Google sign-in, secure D1-backed sessions, a workspace dashboard, and a clear checklist for Sheet, Telegram, and test-link readiness.
- [x] Let the signed-in owner create a workspace on first sign-in, view connection status, choose/change a Sheet by link, disconnect the Sheet, and see recent jobs/errors without internal codes.
- [x] Require fresh authentication for sensitive account actions and validate same-origin return paths, one-time OAuth state, CSRF values, session expiry, and account-to-workspace membership.
- [x] Show actual next actions in plain language, including “Paste a Sheet link” and “Add the bot to your Telegram group”; no service-account keys or chat IDs are requested.
- [ ] Provision staging identities and test workspaces separately from production.

Tests and evidence:

- [x] Auth/session tests cover logout, expired sessions, CSRF/state mismatch, wrong-workspace access, direct unauthenticated setup access, Sheet validation, and reauthentication checks (65 tests pass).
- [x] Usability test: the owner completed Google sign-in and Sheet connection from the hosted page without Cloudflare commands; a broader non-technical pilot remains a later rollout check.
- [x] Setup page includes responsive/mobile CSS, semantic labels, keyboard-submit forms, visible status text, and no-store caching; a manual browser usability pass remains before public onboarding.

Exit gate: complete for the current owner on 2026-09-24 after live sign-in and Sheet connection. Staging identities remain a rollout hardening item. Phase 15 is now in progress.

### Phase 15 — Link Telegram chats to workspaces

Build:

- [x] Use one shared Telegram bot. Generate a 15-minute, single-use connection token in the setup page; support private-chat `start` and group `startgroup`/`/connect` links.
- [x] Confirm the chat type and connecting Telegram user's authority before binding a group. Expire and consume tokens; prevent one active chat from being silently claimed by another workspace.
- [x] Explain group privacy/admin requirements during onboarding; core admin/bot-admin checks and reconnect handling are implemented. Bot removal, group migration, and renamed-group recovery remain edge-case tests.
- [x] Resolve workspace by registered chat ID for every incoming update. Unknown chats receive a safe setup hint and cannot enqueue jobs.
- [x] Preserve rapid webhook acknowledgement and one edited progress message per job. Duplicate/retry notifications remain scoped to the relevant chat.

Tests and evidence:

- [x] Simulate private chat, successful/unauthorized group chat, expired/reused tokens, wrong user, and unconnected-chat URL rejection (73 tests pass).
- [ ] Two groups in separate workspaces submit the same URL; verify independent jobs and notifications.
- [ ] Live staging onboarding with a fresh Telegram account/group, without manually entering a chat ID.

Exit gate: Phase 15 core linking is deployed; final gate requires live staging onboarding and the remaining group lifecycle edge-case tests. Phase 16 has not started.

### Phase 16 — Connect and provision Google Sheets without Apps Script setup

Build:

- [ ] Implement Google OAuth with the narrowest practical file access. Prefer app-created or user-selected files with per-file access where feasible; confirm the required scopes and any Google verification requirements before public release.
- [ ] Let the user create a new Sheet or select an eligible existing Sheet in the setup page. Validate ownership/permission, store the spreadsheet ID per workspace, and initialize `Links`, `Status`, `Failures`, and `Archive` with headers, formatting, and a version marker.
- [ ] Store refresh credentials encrypted with access controls separate from ordinary job data; support refresh, rotation, revoke/disconnect, and reconnect. Never put tokens in logs, Telegram, exports, or source control.
- [ ] Replace the hosted path's single global signed Apps Script bridge with per-workspace Sheets API writes. Keep the bridge for the legacy personal bot until migration is proven.
- [ ] Match records using a stable record key rather than a row number alone; reconcile after partial writes, row movement, and retries. Version and migrate Sheet layouts without overwriting user-entered cells.
- [ ] Make a deliberate choice for direct Sheet edits: keep actions in the hosted web/bot interface initially, or add a bounded reconciliation mechanism for Sheet-side `action`/editable columns. Do not imply that direct Sheet edits sync automatically until implemented and tested.

Tests and evidence:

- [ ] Test consent cancellation, insufficient scope, wrong Sheet permission, expired/revoked token, refresh failure, and user reconnect.
- [ ] Test fresh Sheet creation and an existing Sheet with user data; verify no unrelated tabs/rows are altered.
- [ ] Inject timeouts immediately before/after a Sheet append and re-run the same Queue job; exactly one row must remain, with correct D1 linkage.
- [ ] Two users connect different Sheets and process the same URL; verify complete isolation.
- [ ] Manually inspect the resulting Sheet on desktop and mobile with a non-technical pilot user.

Exit gate: a user can authorize a Sheet through the browser and see reliable records without opening Apps Script.

### Phase 17 — Preserve editing, archive, restore, and export workflows

Build:

- [ ] Give users simple web or Telegram actions to edit title, summary, note, type, deadline, and tags; Archive, Restore, Delete; and retry a failed link. Keep D1 JSON, Sheet row, and Telegram responses consistent.
- [ ] Decide and document direct-in-Sheet edit behavior. If required, build scheduled/notification-based reconciliation with a visible “Save edits” state, conflict rules, bounded polling, and clear sync timestamps. If not, remove misleading Sheet action controls from hosted Sheets and route users to the app.
- [ ] On restore, append or place the record in the next safe `Links` row even if its old row was reused. On delete, retain a scoped audit record according to the retention policy and allow deliberate resubmission.
- [ ] Add per-workspace JSON/CSV export and full account deletion requests; make the resulting state visible to the owner.
- [ ] Keep Calendar/reminders out of this phase; retain extracted event fields for a later opt-in feature.

Tests and evidence:

- [ ] Edit a saved record, archive it, add a new link, then restore the old record; verify no row is overwritten or duplicated.
- [ ] Retry each action after a simulated Sheets failure and after a repeated click; verify idempotent results and helpful messages.
- [ ] Verify exports contain only the requesting workspace's records; account deletion and retention tests remove or preserve exactly what policy says.
- [ ] If direct Sheet edits are supported, test simultaneous web/Sheet edits and the documented conflict rule.

Exit gate: hosted users can manage records as easily as the current owner, and the chosen Sheet-edit behavior is truthful in the UI.

### Phase 18 — Shared-service limits, provider reliability, and cost control

Build:

- [ ] Set workspace-level per-minute/day link limits, maximum URLs per message, page/prompt size, Queue concurrency, and provider timeout/retry budgets based on Phase 12 measurements.
- [ ] Track requests, input/output tokens when available, provider cost estimates, and failure rates by workspace without exposing one workspace's usage to another.
- [ ] Keep Groq as the primary extractor and TinyFish as the primary reader; define an operator-controlled fallback and circuit-breaker behavior for provider outages. Classify quota exhaustion separately from transient 429s.
- [ ] Prevent one workspace's burst or malformed page from exhausting shared capacity. Communicate limits and retry time in plain language.

Tests and evidence:

- [ ] Burst/load tests with several workspaces, including one noisy workspace; verify fair progress and that provider quotas are respected.
- [ ] Inject Groq/TinyFish quota exhaustion, timeout, invalid JSON, and blocked pages; verify bounded retries, correct DLQ behavior, and safe notifications.
- [ ] Compare usage counters with provider bills/usage dashboards on a controlled test batch.

Exit gate: expected traffic fits the budget and a single workspace cannot monopolize the service.

### Phase 19 — Operations, support, privacy, and recovery

Build:

- [ ] Add an operator dashboard for Queue depth, stuck/failed jobs, DLQ, provider failures, OAuth reconnects, and per-workspace usage. Restrict admin actions and record who replayed or changed a job.
- [ ] Send actionable alerts for repeated job failures, provider outage, Sheets auth loss, backlog, and failed migrations. Keep user-facing errors specific but free of internal details.
- [ ] Implement export, disconnect, account deletion, and retention requests end to end. Publish privacy/terms pages before inviting public users; identify which page content goes to TinyFish and Groq.
- [ ] Document incident response, credential rotation, D1 recovery, Sheet reconciliation, support contact, and restoration after a bad release.

Tests and evidence:

- [ ] Trigger each alert in staging and confirm recipient, message, and recovery instructions.
- [ ] Attempt an unauthorized admin replay and a cross-workspace support lookup; both must fail and be audited.
- [ ] Restore a staging D1 copy and reconnect a Sheet; verify representative records and explain any expected loss window.
- [ ] Test account deletion/export and check logs, Queue messages, and backups against the documented retention policy.

Exit gate: an operator can diagnose and recover a failed workspace without reading another user's data or manually editing production rows.

### Phase 20 — Central releases and a small non-technical pilot

Build:

- [ ] Use separate staging and production Cloudflare resources, bot credentials, OAuth clients, and Sheets. Build a release path: tests → additive migration → staging deployment → smoke test → pilot/canary → wider production rollout.
- [ ] Use feature flags for new behavior and versioned D1/Sheet schemas. Keep old and new code compatible during each rollout; prepare a code rollback and data-forward recovery for migrations.
- [ ] Recruit 3–5 people who did not build the bot. Observe setup completion, first successful link, errors, and support requests. Improve confusing steps before opening enrollment.
- [ ] Decide whether the owner's existing personal bot stays separate or moves to the hosted service. If migrating, rehearse data/Sheet mapping on copies and record a rollback point before touching the live installation.
- [ ] Deploy one visible improvement centrally and verify that every pilot user receives it without running a command or changing their Sheet script.

Tests and evidence:

- [ ] Full staging journey for each pilot: sign in → connect Telegram → connect Sheet → send link → edit/archive/restore → export/disconnect.
- [ ] Migration rehearsal against a D1/Sheet copy; compare job counts, record keys, statuses, actions, and Sheet rows.
- [ ] Canary rollback drill after a deliberately bad test release; verify no job loss or cross-workspace notification.
- [ ] Pilot success measures: setup completion rate, time to first saved link, duplicate rate, failure/recovery rate, support requests, and per-user cost. Set thresholds before wider launch.

Exit gate: pilot users can operate without technical help, data remains isolated, and one central update reaches them safely.

### Phase 21 — Public availability (after pilot gates)

- [ ] Complete any Google OAuth app publication/verification required for the chosen scopes, final privacy/terms/support pages, and a clear consent explanation.
- [ ] Set service limits, abuse handling, incident contact, and an operator capacity budget. Add payment/billing only if the business model requires it.
- [ ] Open registration gradually and monitor onboarding, Queue lag, provider errors, Sheet writes, and per-workspace cost. Pause new signups if capacity or recovery targets are missed.
- [ ] Schedule Calendar/reminders as a separate opt-in project after the link-saving product is stable.

Exit gate: a user can join and receive future improvements without technical setup, while the operator can measure and recover the service.

### Shared test and release checklist for Phases 12–21

- [ ] Unit tests cover new logic; integration tests cover D1, Queue, Telegram, and Sheets boundaries affected by the phase.
- [ ] Every phase has at least one negative test for authorization/isolation and one retry or partial-failure test where external writes are involved.
- [ ] Run `npm test -- --run` and `npx wrangler deploy --dry-run`; record staging smoke-test evidence and the deployed commit for releases.
- [ ] Review migrations against a copy of current data; review changes for credentials, private content, and unbounded provider costs.
- [ ] Confirm the personal bot still works until a separately reviewed migration or retirement decision.

Implementation references: [Telegram bot deep links](https://core.telegram.org/bots/features#deep-linking), [Google Sheets OAuth scopes](https://developers.google.com/workspace/sheets/api/scopes), [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), and [Cloudflare D1 recovery](https://developers.cloudflare.com/d1/reference/time-travel/). Recheck each provider's current requirements when its phase starts.

## Historical single-user migration plan (Phases 1–11)

The sections below record how this installation was built. Their “Next” notes are historical; the checkboxes below have been reconciled against the live deployment on 2026-09-24. Use Phases 12–21 above for new work.

## Current progress (2026-09-24)

- Phase 1–2: complete and deployed. `/health` and secret-protected `/telegram` are routed, tested, and the public health endpoint has been verified.
- Phase 3: current Worker secrets/vars are configured for Telegram, TinyFish, Groq, the Sheets bridge, and the allowlist. Gemini remains an explicit opt-in; Firecrawl is intentionally disabled until its key is provided. Secret values are not stored in this repository.
- Phase 4: D1 `telegram-link-bot-db` is bound as `DB`; migrations `0001_initial.sql` through `0004_lifecycle_actions.sql` are applied remotely. Jobs, errors, sheet metadata, lifecycle state, and deletion audit fields are present.
- Phase 5: `telegram-link-jobs` and `telegram-link-jobs-dlq` exist with deployed producer/consumer bindings, bounded retries, and DLQ configuration.
- Phase 6: Telegram intake is live. URL extraction/normalization, allowlisting, deduplication, Queue publication, progress updates, and duplicate responses have been exercised end to end. The Worker webhook is active; the old Apps Script webhook remains available only as rollback code.
- Phase 7: TinyFish is the primary page reader; Firecrawl remains an optional fallback. UTF-8 cleanup, UI-noise cleanup, response-size limits, and controlled provider errors are implemented.
- Phase 8: Groq `openai/gpt-oss-120b` is the deployed primary extractor. Strict schema mode falls back to JSON Object Mode and normalizes partial output; websites, grants, competitions, events, tools, articles, and other reference pages are classified. Gemini remains opt-in.
- Phase 9: Google Sheets bridge is live with `Links`, `Status`, `Failures`, and `Archive` tabs, URL-hash idempotency, row tracking, signed Save edits/Archive/Restore/Delete actions, dropdown types, deadline/tags fields, and formatted Telegram results. The latest Apps Script bridge code and trigger still need a final manual verification in the Sheet.
- Phase 10–11: automated tests cover the core duplicate, provider, schema, sheet-action, and Phase 12 operations paths; the production Telegram webhook has been switched and successful jobs have been observed. The broader Phase 10 outage/load matrix remains a separate historical follow-up.
- Phase 12 deployment evidence: Worker version `5ac670e9-ccd1-48a2-9868-b96183de5b66`, D1 migration `0005_phase12_operations.sql` applied remotely, 15-minute scheduled operations trigger enabled, both main/DLQ consumers deployed, and the admin secret/recipient secrets configured.
- Deployment baseline: D1 database `ff71f2d7-cd58-4122-aa9e-ef24c65c5733`, queues `telegram-link-jobs`/`telegram-link-jobs-dlq`, and consumer settings are recorded from the current configuration. Git commit is recorded after this Phase 12 change is committed.
- Phase 12 acceptance gate: complete. The current single-user Worker has baseline metrics, recovery controls, restore evidence, and 51 passing tests.
- Phase 13 acceptance gate: complete on 2026-09-24. Migration `0006_workspaces.sql` is live, the deployed Worker version is `f8f99b4e-278a-46ad-81f5-d9ef1a6ab20f`, and 58 tests passed before Phase 14 began.
- Calendar/reminder integration remains intentionally deferred.

## Definition of done

- [x] Authenticated Telegram updates containing URLs are accepted exactly once.
- [x] URLs are normalized and duplicate work is prevented.
- [x] Durable job/error state exists in D1.
- [x] Page reading uses TinyFish as primary; Firecrawl is optional fallback and remains disabled without its key.
- [x] The configured extractor output is schema-validated before persistence (Groq primary; Gemini opt-in).
- [x] Google Sheets rows are idempotent. Calendar/reminder integration is explicitly deferred.
- [x] Users receive useful Telegram status messages without credential or internal-error leakage.
- [ ] Queue retries, the dead-letter queue, rate limits, blocked pages, and provider outages are tested.
- [ ] Operational logs identify a request/job across services.
- [ ] The production webhook is switched only after migration approval, with a tested rollback path.

## Phase 1 — Add `/health` and `/telegram` routes

Tasks:

- [x] Replace the starter response with explicit routing.
- [x] Add `GET /health` returning stable JSON.
- [x] Add `POST /telegram` with request content-type and body-size checks.
- [x] Validate `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET`.
- [x] Parse Telegram updates defensively and support text/message entity URL extraction.
- [x] Return `404` for unknown paths and `405` for wrong methods.
- [x] Add unit/integration tests for success, malformed JSON, wrong method, missing/invalid secret, unsupported update, and unknown route.
- [x] Keep this phase independent of D1 and Queue; use a safe acknowledgement/stub response until bindings exist.

Acceptance criteria:

- [x] `npm test` passes.
- [x] `/health` is deterministic and contains no secret/configuration values.
- [x] `/telegram` cannot be invoked without the correct secret header.
- [x] Invalid input produces a controlled `4xx`, not a stack trace or `5xx`.
- [x] No request path makes a slow third-party API call.

## Phase 2 — Deploy and test the Worker

Tasks:

- [x] Run `npm test` and `npx wrangler deploy --dry-run`.
- [x] Deploy the reviewed commit with `npm run deploy`.
- [x] Verify `GET https://telegram-link-bot.pcbot.workers.dev/health`.
- [x] Send authenticated and unauthenticated synthetic requests to `/telegram` without altering Telegram's webhook.
- [ ] Inspect `npx wrangler tail telegram-link-bot` for structured, redacted logs.
- [x] Record deployed commit SHA, deployment time, and smoke-test evidence.

Acceptance criteria:

- [x] Production `/health` returns `200` with expected JSON.
- [x] Unknown routes return `404`; incorrect methods return `405`.
- [x] A synthetic valid Telegram fixture is acknowledged.
- [x] Authentication failure is visible as a safe status code and does not leak either token.
- [x] The legacy Apps Script implementation remains available as rollback code after the Worker cutover.

## Phase 3 — Add Cloudflare secrets

Confirm exact secret names in code first, then enter values interactively:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TINYFISH_API_KEY
# Optional later: npx wrangler secret put FIRECRAWL_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GOOGLE_SHEETS_BRIDGE_SECRET
```

Add `GOOGLE_SHEETS_BRIDGE_URL`, `GOOGLE_SHEETS_BRIDGE_SECRET`, and `TELEGRAM_ALLOWED_CHAT_IDS` as secrets if their disclosure is undesirable; otherwise use reviewed plain `vars` for non-sensitive identifiers. Do not configure Calendar credentials yet.

Tasks and safety checks:

- [x] Use high-entropy, independently generated webhook secret material.
- [x] Use a dedicated Apps Script bridge with a narrow shared secret.
- [ ] Keep the bridge restricted to the target Sheet. Calendar access is deferred.
- [ ] Create a redacted `.dev.vars.example` if local development needs documentation.
- [x] Confirm `.dev.vars*` and `.env*` remain ignored except explicit example files.
- [x] Confirm source, Git diff, logs, screenshots, issues, and PR text contain no secret values.
- [ ] Document credential owners and rotation procedure outside the repository.

Acceptance criteria:

- [x] Required bindings are visible to the deployed Worker by name, with values never returned or logged.
- [x] Missing-secret behavior is a controlled configuration error.
- [ ] A test credential can be rotated without a code change.

## Phase 4 — Create D1 and the `jobs`/`errors` tables

Proposed creation command:

```powershell
npx wrangler d1 create telegram-link-bot-db --binding DB --update-config
```

Create numbered SQL migrations under `migrations/`; do not manage the production schema with ad hoc dashboard edits.

Minimum `jobs` design:

- `id`: application-generated UUID/text primary key
- `telegram_update_id` plus `url_index`: unique idempotency key for each URL in a Telegram update
- `chat_id` and optional `message_id`
- `original_url`, `normalized_url`, and `url_hash`
- `status`: constrained state such as `queued`, `processing`, `completed`, `failed`, `dead_letter`
- `attempt_count`, `provider`, and optional external result identifiers
- `created_at`, `updated_at`, `completed_at`

Minimum `errors` design:

- `id`, `job_id`, `stage`, `error_code`, redacted `message`
- `retryable`, `provider_status`, `attempt_number`, `created_at`
- foreign key/index appropriate for job-history lookup

Tasks:

- [x] Define a deterministic URL-normalization policy before creating the uniqueness rule.
- [x] Define whether resubmission after completion is blocked forever or allowed after a window.
- [x] Add indexes for status/created time, Telegram update lookup, and URL deduplication.
- [x] Apply migrations locally first, then remotely with an explicit `--remote` operation.
- [x] Test insert, duplicate update, duplicate normalized URL, state transitions, and error history.
- [x] Never store Telegram bot tokens, API keys, full auth headers, or Google private keys in D1.

Acceptance criteria:

- [x] Migrations are versioned, reproducible, and reviewed.
- [x] Telegram retries cannot create two jobs.
- [ ] Concurrent submissions of the same normalized URL have deterministic behavior.
- [x] Job state transitions and error records are queryable by job ID.
- [x] Production database identifier/binding is committed, but no credential is.

## Phase 5 — Create Queue and dead-letter Queue

Create resources only after names and environment strategy are agreed:

```powershell
npx wrangler queues create telegram-link-jobs
npx wrangler queues create telegram-link-jobs-dlq
```

Tasks:

- [x] Add producer binding `JOBS_QUEUE` in `wrangler.jsonc`.
- [x] Add a consumer for `telegram-link-jobs` with conservative batch size/retry settings.
- [x] Configure `telegram-link-jobs-dlq` as the dead-letter queue.
- [x] Define a versioned, minimal Queue message contract: `jobId`, schema version, and correlation ID.
- [x] Load job details from D1 rather than duplicating sensitive payloads in Queue messages.
- [x] Make the consumer idempotent and safe under at-least-once delivery.
- [x] Record an `errors` row per failed stage/attempt, with redaction.
- [ ] Document replay/manual-resolution behavior for DLQ messages.

Acceptance criteria:

- [x] Intake atomically or recoverably coordinates the D1 job and Queue publish.
- [x] Re-delivery does not duplicate downstream writes.
- [x] Retryable failures retry with bounded attempts/backoff.
- [ ] Exhausted messages reach the DLQ and the job becomes `dead_letter`.
- [x] A successful message is acknowledged only after durable state is updated.

## Phase 6 — Connect Telegram intake

Implementation status: deployed and exercised end to end. The production webhook cutover is documented in Phase 11.

Tasks:

- [x] Enforce webhook secret validation and optional chat/user allowlist.
- [x] Extract all supported URL entities and plain-text URLs.
- [x] Permit only `http:` and `https:` URLs.
- [x] Normalize host casing, fragments, and default ports. Tracking-parameter policy remains to be finalized.
- [x] Reject obvious localhost, private, and link-local hosts at intake; redirect-target validation remains a consumer responsibility.
- [x] Persist/enqueue each accepted URL idempotently.
- [x] Send concise responses for accepted, duplicate, unsupported, and failed submissions.
- [x] Test through fixtures with fake D1/Queue bindings; production cutover is tracked separately in Phase 11.

Acceptance criteria:

- [x] The same `update_id` is harmless when delivered repeatedly.
- [x] The same normalized URL produces the documented duplicate response.
- [x] Unauthorized chats cannot enqueue work.
- [x] Intake remains fast when downstream providers are unavailable.
- [x] Production Telegram traffic has moved to the Worker; the old Apps Script webhook remains retained for rollback.

## Phase 7 — Add TinyFish page reading

Implementation status: TinyFish Fetch provider layer is deployed and used by the Queue processor. Firecrawl fallback is retained but disabled unless its key exists.

Tasks:

- [x] Implement a TinyFish Fetch provider interface.
- [x] Retain Firecrawl as an optional fallback only when `FIRECRAWL_API_KEY` is present.
- [x] Define retryable HTTP failures and empty-content handling; parsing-specific handling remains part of processor integration.
- [x] Set strict total timeouts and response-size limits; redirect-target validation remains required in the consumer.
- [ ] Revalidate every redirect target against the SSRF policy.
- [x] Record provider name, status, latency, and redacted failure code in the provider result/error model.
- [x] Avoid persisting full page bodies unless necessary; establish a retention policy first.
- [ ] Treat fetched instructions/scripts as untrusted data.

Acceptance criteria:

- [x] Normal pages produce clean source content in provider tests.
- [x] TinyFish provider failures return controlled retryable/permanent errors.
- [x] Oversized, empty, timeout-class, and `429` cases have controlled provider outcomes; binary and redirect cases remain processor integration tests.
- [ ] Provider credentials and fetched private data are absent from logs.

## Phase 8 — Structured extraction (Groq primary; Gemini opt-in)

Implementation status: Groq GPT-OSS 120B is deployed as the primary extractor. Gemini remains available only when explicitly selected.

Extraction contract for each cleaned page:

- `post_body`: actual author-written post text, excluding navigation, buttons, reactions, prompts, and profile UI
- `hashtags`: normalized list of hashtags without duplicates
- `author`: display name and profile URL when present
- `published_at`: ISO-8601 date/time when confidently available, otherwise `null`
- `event`: nullable object containing `name`, `start_at`, `end_at`, `timezone`, `location`, and `url`
- `source_url`: submitted URL
- `confidence_notes`: short explanation of ambiguity; never invent missing facts

Tasks:

- [x] Define and version the output JSON schema before prompt implementation.
- [x] Use `openai/gpt-oss-120b` as the deployed default model; Gemini `gemini-2.5-flash` remains an explicit opt-in.
- [x] Request structured JSON and validate every response server-side.
- [x] Include source URL and a bounded amount of page content.
- [x] Defend against prompt injection by clearly treating page text as data.
- [x] Add bounded retries and rate-limit handling; timeout/token-budget tuning remains a live-provider check.
- [x] Store schema version, provider, and validation errors for traceability.
- [x] Define the initial post/author/date/hashtag/event fields; Sheet column mapping remains to be finalized and Calendar eligibility is deferred.

Acceptance criteria:

- [x] Valid pages yield schema-valid data.
- [x] Missing/ambiguous fields use explicit null/unknown values rather than invented facts.
- [x] Malformed model output is not written to Google destinations.
- [x] Rate limits and safety refusals have controlled, observable outcomes.
- [ ] Test fixtures cover ordinary content, hostile instructions, sparse pages, and invalid output.

## Phase 9 — Connect Google Sheets (Calendar deferred)

Tasks:

- [x] Use a dedicated bridge project with access only to the test Sheet initially.
- [x] Define a small, action-oriented main tab and keep technical fields out of the normal view.
- [x] Use the job ID or URL hash as an idempotency key for row writes.
- [x] Store the returned Sheet row identifier in D1.
- [x] Make retries update/reconcile the same Sheet row rather than create duplicates.
- [x] Send Telegram success/failure summaries only after durable state is recorded.

Acceptance criteria:

- [x] A completed job creates exactly one expected Sheet row.
- [x] Retries and Queue redelivery do not create duplicate Sheet rows.
- [x] Partial Sheet failure is recoverable and observable.
- [ ] Test Sheet and latest Apps Script column/action mapping are verified manually.

Implementation notes:

- The main `Links` tab is initialized with these visible headers: `timestamp`, `title`, `original_message`, `link`, `summary`, `user_note`, `type`, `deadline`, `tags`, `shared_by_name`, and `shared_by_username`. A hidden `_record_key` column keeps URL-hash deduplication reliable.
- `type` uses a controlled list: `grant`, `competition`, `article`, `event`, `tool`, `report`, `opportunity`, `website`, and `other`. `website` covers competitor, organization, product, and general reference homepages. `deadline` is extracted for explicit application, submission, registration, grant, or competition deadlines regardless of type.
- The bridge checks the URL hash before append, so a Queue retry after a successful append reconciles the existing row instead of creating a duplicate.
- D1 stores `sheet_row_number` and `sheet_synced_at` after the Sheet write.
- `Status` and `Failures` tabs are created automatically if they do not exist; their names can be changed through Apps Script properties `STATUS_TAB` and `FAILURES_TAB`. The bridge freezes headers, adds filters, wraps long text, sizes columns, and keeps a legacy wide `Sheet1` intact when it detects the old schema.

## Deferred Phase — Calendar and Telegram reminders

Do not build or configure Calendar during the current migration. Preserve event-related fields in the extracted JSON (date, time, timezone, location, and event name) so a future opt-in Calendar/reminder feature can use existing records without changing ingestion. A later version may add a Telegram command or per-item option such as “remind me N days before” and create a Calendar event only after explicit user confirmation.

## Phase 10 — Failure, duplicate, rate-limit, and blocked-page testing

Run an evidence-backed migration test matrix:

- [ ] Duplicate Telegram `update_id`.
- [ ] Same URL with fragments, casing differences, default ports, and tracking parameters.
- [ ] Multiple URLs in one message.
- [ ] Invalid, non-HTTP, private-network, and redirect-to-private URLs.
- [ ] TinyFish timeout/`429`/`5xx`/blocked content.
- [ ] Firecrawl fallback timeout/`429`/`5xx`/blocked content when enabled.
- [ ] Gemini (explicit opt-in) invalid JSON, schema mismatch, refusal, timeout, `429`, and `5xx`.
- [ ] Groq primary success, strict-schema/JSON-object fallback, invalid JSON, timeout, `429`, and `5xx`.
- [ ] Google Sheets auth failure, permission failure, quota limit, and partial write.
- [ ] Telegram send failure and Telegram rate limit.
- [ ] Queue redelivery, retry exhaustion, and DLQ arrival.
- [ ] Worker restart/redeployment while jobs are queued.
- [ ] Redaction review of logs, D1 errors, Telegram messages, and GitHub artifacts.
- [ ] Load test within expected traffic and provider limits.

Acceptance criteria:

- [ ] Every test has expected/actual outcome and a correlation/job ID.
- [ ] No tested failure loses a job silently or creates unintended duplicates.
- [ ] Retryable and permanent failures are distinguished correctly.
- [ ] DLQ handling and manual replay are demonstrated.
- [ ] Alerts/operational queries identify stuck, failed, and dead-letter jobs.
- [ ] Rollback procedure is rehearsed without touching the live webhook.

## Phase 11 — Switch the Telegram webhook (cutover completed; observation ongoing)

This is the only phase authorized to change the production webhook, and it requires explicit migration approval.

Pre-cutover checklist:

- [ ] Phases 1–10 meet their acceptance criteria.
- [ ] Record the existing Apps Script webhook URL/configuration securely for rollback.
- [x] Confirm Worker health, D1 migrations, Queue consumer, DLQ, secrets, and Google permissions.
- [x] Confirm `TELEGRAM_WEBHOOK_SECRET` is configured in both Worker validation and webhook registration.
- [ ] Choose a low-traffic window and name the operator/observer.
- [ ] Prepare exact cutover, verification, and rollback commands without embedding the bot token in committed files or shared logs.
- [ ] Decide how pending Apps Script work will be drained or reconciled.

Cutover verification:

- [x] Switch the webhook to `https://telegram-link-bot.pcbot.workers.dev/telegram`.
- [x] Verify Telegram reports the expected webhook URL and no delivery error.
- [x] Submit a unique test URL and observe intake, Queue, extraction, Google outputs, and Telegram completion.
- [x] Submit the same URL/update behavior and verify deduplication.
- [ ] Monitor failures, latency, Queue backlog, DLQ, and provider limits during the observation window.
- [ ] Keep Apps Script deployed but inactive until the observation period passes.

Rollback criteria:

- Authentication failures, sustained `5xx`, unexpected duplicates, data corruption, unbounded backlog, credential leakage, or inability to notify users trigger rollback. Restore the recorded Apps Script webhook, stop new Worker intake safely, preserve D1/Queue evidence, and investigate without deleting state.

Final acceptance criteria:

- [x] Production end-to-end test passes.
- [ ] Monitoring remains healthy for the agreed observation period.
- [x] Rollback remains possible and documented.
- [ ] Apps Script is retired only through a separate, explicit decision after migration acceptance.

## Pull-request checklist for every phase

- [ ] Scope matches one plan phase or explains why phases are combined.
- [ ] Tests cover new success and failure paths.
- [ ] `npm test` and `npx wrangler deploy --dry-run` pass where applicable.
- [ ] Database/config changes are reproducible and include rollback considerations.
- [ ] New secrets are documented by name only.
- [ ] Logs and examples are redacted.
- [ ] No real credentials, service-account data, private content, or production update payloads appear in the diff.
- [ ] Deployment and verification steps are in the PR description.
- [ ] Existing Apps Script remains untouched unless this is the separately approved cutover/retirement change.
