import { extractWithGemini } from "./gemini";
import { extractWithGroq } from "./groq";
import { recordFailureToSheets, syncJobToSheets, syncStatusToSheets } from "./google-sheets";
import { readPage } from "./page-reader";
import { editTelegramMessage, sendTelegramMessage } from "./telegram";

// wrangler.jsonc configures max_retries=3, so a message can be processed four times total.
const MAX_QUEUE_ATTEMPTS = 4;

async function recordError(db, jobId, error, workspaceId = "workspace_default") {
	try {
		await db.prepare("INSERT INTO errors (job_id, stage, error_code, message, retryable, provider_status, attempt_number, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(jobId, error.stage ?? error.provider ?? "processor", error.code ?? "processor_error", String(error.message ?? "Processor failed").slice(0, 500), error.retryable ? 1 : 0, error.status ?? null, error.attemptNumber ?? 0, workspaceId).run();
	} catch {
		await db.prepare("INSERT INTO errors (job_id, stage, error_code, message, retryable, provider_status, attempt_number) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(jobId, error.stage ?? error.provider ?? "processor", error.code ?? "processor_error", String(error.message ?? "Processor failed").slice(0, 500), error.retryable ? 1 : 0, error.status ?? null, error.attemptNumber ?? 0).run();
	}
}

export function formatSuccessMessage(url, extraction, sheetResult = null, extractor = "gemini") {
	const escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	const lines = [
		"✅ <b>Processed successfully</b>",
		"",
		`<b>Title</b>\n${escapeHtml(extraction.title)}`,
		"",
		`<b>Summary</b>\n${escapeHtml(extraction.summary)}`,
		"",
		`<b>Type</b>: ${escapeHtml(extraction.type)}`,
		`<b>Extractor</b>: ${escapeHtml(extractor)}`,
	];
	if (extraction.author) lines.push(`<b>Author</b>: ${escapeHtml(extraction.author)}`);
	if (extraction.published_at) lines.push(`<b>Published</b>: ${escapeHtml(extraction.published_at)}`);
	if (extraction.deadline) lines.push(`<b>Deadline</b>: ${escapeHtml(extraction.deadline)}`);
	if (extraction.event?.name) lines.push(`<b>Event</b>: ${escapeHtml(extraction.event.name)}`);
	if (sheetResult?.status === "saved" && sheetResult.rowNumber) lines.push(`<b>Sheet row</b>: ${escapeHtml(sheetResult.rowNumber)}`);
	lines.push("", `<b>Source</b>: <a href="${escapeHtml(url)}">Open link</a>`);
	return lines.join("\n");
}

async function updateProgress(job, messageId, text, env, fetchImpl, parseMode = null) {
	if (messageId === null || messageId === undefined) return false;
	try {
		const result = await editTelegramMessage(job.chat_id, messageId, text, env, fetchImpl, parseMode);
		return !result.skipped;
	} catch {
		return false;
	}
}

async function sendOrEditProgress(job, messageId, text, env, fetchImpl, parseMode = null) {
	if (await updateProgress(job, messageId, text, env, fetchImpl, parseMode)) return;
	await sendTelegramMessage(job.chat_id, text, env, fetchImpl, parseMode);
}

function sheetsConfigured(env) {
	return Boolean(env?.GOOGLE_SHEETS_BRIDGE_URL || env?.GOOGLE_SHEETS_BRIDGE_SECRET);
}

async function updateSheetStatus(job, status, provider, message, env, fetchImpl, mainRowNumber = null) {
	if (!sheetsConfigured(env)) return;
	try { await syncStatusToSheets(job, status, provider, message, env, fetchImpl, mainRowNumber); } catch { /* status tabs are secondary to the durable D1 state */ }
}

async function updateSheetFailure(job, error, env, fetchImpl) {
	if (!sheetsConfigured(env)) return;
	try { await recordFailureToSheets(job, error, env, fetchImpl); } catch { /* failure tab is best-effort; D1 errors remain authoritative */ }
}

export async function processQueueMessage(message, env, fetchImpl = fetch) {
	const body = message.body;
	if (!body || body.version !== 1 || typeof body.jobId !== "string") {
		message.ack();
		return;
	}
	const job = await env.DB.prepare("SELECT id, workspace_id, canonical_url_hash, normalized_url, url_hash, chat_id, status, attempt_count, created_at, original_message, user_note, sender_name, sender_username FROM jobs WHERE id = ?").bind(body.jobId).first();
	if (!job || job.status === "completed") {
		message.ack();
		return;
	}
	if (body.workspaceId && job.workspace_id && body.workspaceId !== job.workspace_id) {
		const mismatch = Object.assign(new Error("Queue workspace does not match the stored job"), { code: "workspace_mismatch", stage: "workspace", retryable: false });
		await recordError(env.DB, job.id, mismatch, job.workspace_id);
		message.ack();
		return;
	}
	const claim = await env.DB.prepare("UPDATE jobs SET status = 'processing', attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'failed')").bind(job.id).run();
	if (!claim.meta?.changes) {
		message.ack();
		return;
	}
	try {
		await updateSheetStatus(job, "processing", "", "Reading and extracting", env, fetchImpl);
		await updateProgress(job, body.progressMessageId, `🔎 Reading page…\n${job.normalized_url}`, env, fetchImpl);
		const page = await readPage(job.normalized_url, env, fetchImpl);
		await updateProgress(job, body.progressMessageId, `🧠 Extracting summary and tags…\n${job.normalized_url}`, env, fetchImpl);
		let extraction;
		let extractor = "groq";
		if ((env?.EXTRACTION_PROVIDER || "groq").toLowerCase() === "gemini") {
			extractor = "gemini";
			try {
				extraction = await extractWithGemini(job.normalized_url, page.content, env, fetchImpl);
			} catch (geminiError) {
				if (!env?.GROQ_API_KEY) throw geminiError;
				geminiError.attemptNumber = (job.attempt_count ?? 0) + 1;
				await recordError(env.DB, job.id, geminiError, job.workspace_id);
				await updateProgress(job, body.progressMessageId, `⚠️ Gemini unavailable (${geminiError.code}). Trying Groq fallback…\n${job.normalized_url}`, env, fetchImpl);
				try {
					extraction = await extractWithGroq(job.normalized_url, page.content, env, fetchImpl);
					extractor = "groq_fallback";
				} catch (groqError) {
					groqError.message = `Groq fallback failed after ${geminiError.code}: ${groqError.message}`;
					throw groqError;
				}
			}
		} else {
			// Groq-only mode avoids spending Gemini quota and prevents queue retries
			// from reissuing Gemini calls after a provider failure.
			extraction = await extractWithGroq(job.normalized_url, page.content, env, fetchImpl);
		}
		const provider = `${page.provider}+${extractor}`;
		const sheetsConfigured = Boolean(env?.GOOGLE_SHEETS_BRIDGE_URL || env?.GOOGLE_SHEETS_BRIDGE_SECRET);
		const sheetResult = sheetsConfigured
			? await syncJobToSheets(job, extraction, provider, env, fetchImpl)
			: { status: "skipped", reason: "not_configured" };
		const result = JSON.stringify({ schemaVersion: 1, source: { provider: page.provider, status: page.status, latencyMs: page.latencyMs }, extraction, sheets: sheetResult });
		if (sheetResult.status === "saved") {
			await env.DB.prepare("UPDATE jobs SET status = 'completed', provider = ?, result_json = ?, sheet_row_number = ?, sheet_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(provider, result, sheetResult.rowNumber, job.id).run();
		} else {
			await env.DB.prepare("UPDATE jobs SET status = 'completed', provider = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(provider, result, job.id).run();
		}
		await updateSheetStatus(job, "completed", provider, "Saved successfully", env, fetchImpl, sheetResult.rowNumber ?? null);
		try { await sendOrEditProgress(job, body.progressMessageId, formatSuccessMessage(job.normalized_url, extraction, sheetResult, extractor), env, fetchImpl, "HTML"); } catch (notificationError) { notificationError.stage = "telegram"; await recordError(env.DB, job.id, notificationError, job.workspace_id); }
		message.ack();
	} catch (error) {
		const attemptNumber = (job.attempt_count ?? 0) + 1;
		error.attemptNumber = attemptNumber;
		const shouldRetry = Boolean(error.retryable) && attemptNumber < MAX_QUEUE_ATTEMPTS;
		const statusMessage = shouldRetry
			? `Temporary provider error (${error.code ?? "processor_error"}). Retrying automatically (${attemptNumber}/${MAX_QUEUE_ATTEMPTS})`
			: `Processing stopped after ${attemptNumber}/${MAX_QUEUE_ATTEMPTS} attempts (${error.code ?? "processor_error"})`;
		await recordError(env.DB, job.id, error, job.workspace_id);
		await env.DB.prepare("UPDATE jobs SET status = ?, provider = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(shouldRetry ? "queued" : "failed", error.provider ?? "processor", job.id).run();
		await updateSheetStatus(job, shouldRetry ? "queued" : "failed", error.provider ?? "processor", statusMessage, env, fetchImpl);
		await updateSheetFailure(job, error, env, fetchImpl);
		const telegramText = shouldRetry
			? `⏳ ${statusMessage}\n${job.normalized_url}`
			: `⚠️ Processing failed:\n${job.normalized_url}\nCode: ${error.code ?? "processor_error"}\nAttempts: ${attemptNumber}`;
		try { await sendOrEditProgress(job, body.progressMessageId, telegramText, env, fetchImpl); } catch (notificationError) { notificationError.stage = "telegram"; await recordError(env.DB, job.id, notificationError, job.workspace_id); }
		if (shouldRetry) message.retry();
		else message.ack();
	}
}
