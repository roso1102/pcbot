# Action Plan

This plan is ordered to reduce migration risk. Complete each phase's acceptance criteria before moving on. The existing Apps Script code remains available for rollback; the Worker webhook is active after the initial migration test.

## Current progress (2026-09-19)

- Phase 1: complete locally and deployed. `/health` and secret-protected `/telegram` are covered by 8 passing tests.
- Phase 2: complete. The public `/health` endpoint was verified after deployment.
- Phase 3: complete for current processing scope. `TELEGRAM_WEBHOOK_SECRET`, `TINYFISH_API_KEY`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_CHAT_IDS` are configured. Firecrawl remains intentionally disabled without its key.
- Phase 4: complete. D1 `telegram-link-bot-db` is bound as `DB`; migration `0001_initial.sql` created and remotely verified `jobs` and `errors`.
- Phase 5: infrastructure complete. Both Queues exist, bindings and retry/DLQ settings are deployed, and the temporary consumer guard retries messages until the real processor is implemented.
- Phase 6: complete for the first end-to-end path. Intake persisted a Telegram URL in D1 and published a Queue job.
- Phase 7: complete for the first end-to-end path. TinyFish successfully read the LinkedIn short URL; Firecrawl remains optional and disabled.
- Phase 8: complete for the first end-to-end path. Gemini successfully extracted and the job reached `completed` with provider `tinyfish+gemini`.
- Telegram status notifications are implemented and require `TELEGRAM_BOT_TOKEN`; successful jobs now report the Gemini summary, normalized hashtags, author/date/event, and source. Group allowlisting remains optional but recommended.
- Integration audit found and fixed two blockers: TinyFish Fetch responses use `results[0].text`, and Gemini REST structured output uses `response_mime_type`/`response_schema`. The fixes are tested locally; redeploy and a disposable end-to-end job are required.
- The summary/hashtag notification patch passes local tests and dry-run; deploy it before live verification.
- Group UX now uses one Telegram progress message that is edited through queued, reading, extracting, and final states. Telegram draft streaming remains private-chat-only; this staged edit flow is the group-compatible behavior.
- Google Sheets persistence is implemented locally: a compact Links row, URL-hash idempotency check, D1 row-number tracking, and Telegram row-number reporting. The Links Action dropdown now supports signed Archive/Delete synchronization with D1.
- The bridge now maintains a main data tab plus automatically created `Status` and `Failures` tabs. Status is upserted per job; failure records are deduplicated by job/attempt/code.
- Next: verify extracted `result_json`, test duplicates/rate limits/blocked pages and DLQ behavior, then complete Google Sheets persistence. Calendar/reminder integration is deferred until the Sheet workflow is reliable.

## Definition of done

- [ ] Authenticated Telegram updates containing URLs are accepted exactly once.
- [ ] URLs are normalized and duplicate work is prevented.
- [ ] Durable job/error state exists in D1.
- [ ] Page reading uses TinyFish as primary; Firecrawl is optional fallback and remains disabled without its key.
- [ ] Gemini output is schema-validated before persistence.
- [ ] Google Sheets rows are idempotent. Calendar/reminder integration is explicitly deferred.
- [ ] Users receive useful Telegram status messages without credential or internal-error leakage.
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
- [ ] Record deployed commit SHA, deployment time, and smoke-test evidence.

Acceptance criteria:

- [x] Production `/health` returns `200` with expected JSON.
- [x] Unknown routes return `404`; incorrect methods return `405`.
- [x] A synthetic valid Telegram fixture is acknowledged.
- [x] Authentication failure is visible as a safe status code and does not leak either token.
- [x] Apps Script continues serving production traffic unchanged.

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
- [ ] Use a dedicated Apps Script bridge with a narrow shared secret.
- [ ] Keep the bridge restricted to the target Sheet. Calendar access is deferred.
- [ ] Create a redacted `.dev.vars.example` if local development needs documentation.
- [x] Confirm `.dev.vars*` and `.env*` remain ignored except explicit example files.
- [x] Confirm source, Git diff, logs, screenshots, issues, and PR text contain no secret values.
- [ ] Document credential owners and rotation procedure outside the repository.

Acceptance criteria:

- [ ] Required bindings are visible to the deployed Worker by name, with values never returned or logged.
- [ ] Missing-secret behavior is a controlled configuration error.
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

- [ ] Define a deterministic URL-normalization policy before creating the uniqueness rule.
- [ ] Define whether resubmission after completion is blocked forever or allowed after a window.
- [ ] Add indexes for status/created time, Telegram update lookup, and URL deduplication.
- [ ] Apply migrations locally first, then remotely with an explicit `--remote` operation.
- [ ] Test insert, duplicate update, duplicate normalized URL, state transitions, and error history.
- [ ] Never store Telegram bot tokens, API keys, full auth headers, or Google private keys in D1.

Acceptance criteria:

- [x] Migrations are versioned, reproducible, and reviewed.
- [ ] Telegram retries cannot create two jobs.
- [ ] Concurrent submissions of the same normalized URL have deterministic behavior.
- [ ] Job state transitions and error records are queryable by job ID.
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
- [ ] Define a versioned, minimal Queue message contract: `jobId`, schema version, and correlation ID.
- [ ] Load job details from D1 rather than duplicating sensitive payloads in Queue messages.
- [ ] Make the consumer idempotent and safe under at-least-once delivery.
- [ ] Record an `errors` row per failed stage/attempt, with redaction.
- [ ] Document replay/manual-resolution behavior for DLQ messages.

Acceptance criteria:

- [ ] Intake atomically or recoverably coordinates the D1 job and Queue publish.
- [ ] Re-delivery does not duplicate downstream writes.
- [x] Retryable failures retry with bounded attempts/backoff.
- [ ] Exhausted messages reach the DLQ and the job becomes `dead_letter`.
- [ ] A successful message is acknowledged only after durable state is updated.

## Phase 6 — Connect Telegram intake (without production cutover)

Implementation status: local code complete; deployment and remote end-to-end verification are pending.

Tasks:

- [ ] Enforce webhook secret validation and optional chat/user allowlist.
- [x] Extract all supported URL entities and plain-text URLs.
- [x] Permit only `http:` and `https:` URLs.
- [x] Normalize host casing, fragments, and default ports. Tracking-parameter policy remains to be finalized.
- [x] Reject obvious localhost, private, and link-local hosts at intake; redirect-target validation remains a consumer responsibility.
- [x] Persist/enqueue each accepted URL idempotently.
- [ ] Send concise responses for accepted, duplicate, unsupported, and failed submissions.
- [x] Test through fixtures with fake D1/Queue bindings; leave the existing production webhook unchanged.

Acceptance criteria:

- [ ] The same `update_id` is harmless when delivered repeatedly.
- [ ] The same normalized URL produces the documented duplicate response.
- [ ] Unauthorized chats cannot enqueue work.
- [ ] Intake remains fast when downstream providers are unavailable.
- [ ] No production Telegram traffic has moved from Apps Script.

## Phase 7 — Add TinyFish page reading

Implementation status: TinyFish Fetch provider layer complete locally; provider is wired into the local Queue processor. Remote smoke test is pending. Firecrawl fallback is retained but disabled unless its key exists.

Tasks:

- [x] Implement a TinyFish Fetch provider interface.
- [x] Retain Firecrawl as an optional fallback only when `FIRECRAWL_API_KEY` is present.
- [x] Define retryable HTTP failures and empty-content handling; parsing-specific handling remains part of processor integration.
- [x] Set strict total timeouts and response-size limits; redirect-target validation remains required in the consumer.
- [ ] Revalidate every redirect target against the SSRF policy.
- [x] Record provider name, status, latency, and redacted failure code in the provider result/error model.
- [ ] Avoid persisting full page bodies unless necessary; establish a retention policy first.
- [ ] Treat fetched instructions/scripts as untrusted data.

Acceptance criteria:

- [x] Normal pages produce clean source content in provider tests.
- [x] TinyFish provider failures return controlled retryable/permanent errors.
- [x] Oversized, empty, timeout-class, and `429` cases have controlled provider outcomes; binary and redirect cases remain processor integration tests.
- [ ] Provider credentials and fetched private data are absent from logs.

## Phase 8 — Add Gemini structured extraction

Implementation status: local Gemini client and Queue processor complete; deployment and live-key verification are pending.

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
- [x] Use `gemini-2.5-flash` as the default model, overridable with `GEMINI_MODEL`.
- [x] Request structured JSON and validate every response server-side.
- [x] Include source URL and a bounded amount of page content.
- [x] Defend against prompt injection by clearly treating page text as data.
- [x] Add bounded retries and rate-limit handling; timeout/token-budget tuning remains a live-provider check.
- [x] Store schema version, provider, and validation errors for traceability.
- [x] Define the initial post/author/date/hashtag/event fields; Sheet column mapping remains to be finalized and Calendar eligibility is deferred.

Acceptance criteria:

- [ ] Valid pages yield schema-valid data.
- [ ] Missing/ambiguous fields use explicit null/unknown values rather than invented facts.
- [ ] Malformed model output is not written to Google destinations.
- [ ] Rate limits and safety refusals have controlled, observable outcomes.
- [ ] Test fixtures cover ordinary content, hostile instructions, sparse pages, and invalid output.

## Phase 9 — Connect Google Sheets (Calendar deferred)

Tasks:

- [ ] Use a dedicated bridge project with access only to the test Sheet initially.
- [ ] Define a small, action-oriented main tab and keep technical fields out of the normal view.
- [ ] Use the job ID or URL hash as an idempotency key for row writes.
- [ ] Store the returned Sheet row identifier in D1.
- [ ] Make retries update/reconcile the same Sheet row rather than create duplicates.
- [ ] Send Telegram success/failure summaries only after durable state is recorded.

Acceptance criteria:

- [ ] A completed job creates exactly one expected Sheet row.
- [ ] Retries and Queue redelivery do not create duplicate Sheet rows.
- [ ] Partial Sheet failure is recoverable and observable.
- [ ] Test Sheet and column mapping are verified manually.

Implementation notes:

- The main `Links` tab is initialized with these visible headers: `timestamp`, `title`, `original_message`, `link`, `summary`, `user_note`, `type`, `deadline`, `tags`, `shared_by_name`, and `shared_by_username`. A hidden `_record_key` column keeps URL-hash deduplication reliable.
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
- [ ] Gemini invalid JSON, schema mismatch, refusal, timeout, `429`, and `5xx`.
- [ ] Groq fallback success, invalid JSON, timeout, `429`, and `5xx`.
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

## Phase 11 — Switch the Telegram webhook

This is the only phase authorized to change the production webhook, and it requires explicit migration approval.

Pre-cutover checklist:

- [ ] Phases 1–10 meet their acceptance criteria.
- [ ] Record the existing Apps Script webhook URL/configuration securely for rollback.
- [ ] Confirm Worker health, D1 migrations, Queue consumer, DLQ, secrets, and Google permissions.
- [ ] Confirm `TELEGRAM_WEBHOOK_SECRET` is configured in both Worker validation and webhook registration.
- [ ] Choose a low-traffic window and name the operator/observer.
- [ ] Prepare exact cutover, verification, and rollback commands without embedding the bot token in committed files or shared logs.
- [ ] Decide how pending Apps Script work will be drained or reconciled.

Cutover verification:

- [ ] Switch the webhook to `https://telegram-link-bot.pcbot.workers.dev/telegram`.
- [ ] Verify Telegram reports the expected webhook URL and no delivery error.
- [ ] Submit a unique test URL and observe intake, Queue, extraction, Google outputs, and Telegram completion.
- [ ] Submit the same URL/update behavior and verify deduplication.
- [ ] Monitor failures, latency, Queue backlog, DLQ, and provider limits during the observation window.
- [ ] Keep Apps Script deployed but inactive until the observation period passes.

Rollback criteria:

- Authentication failures, sustained `5xx`, unexpected duplicates, data corruption, unbounded backlog, credential leakage, or inability to notify users trigger rollback. Restore the recorded Apps Script webhook, stop new Worker intake safely, preserve D1/Queue evidence, and investigate without deleting state.

Final acceptance criteria:

- [ ] Production end-to-end test passes.
- [ ] Monitoring remains healthy for the agreed observation period.
- [ ] Rollback remains possible and documented.
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
