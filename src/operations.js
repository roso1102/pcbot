import { sendTelegramMessage } from "./telegram";

const DEFAULTS = {
	rawTelegramDays: 90,
	resultDays: 365,
	errorDays: 180,
	auditDays: 730,
	stuckMinutes: 15,
	alertLimit: 25,
};

function positiveInt(value, fallback, maximum = 10_000) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

export function retentionConfig(env = {}) {
	return {
		rawTelegramDays: positiveInt(env.RAW_TELEGRAM_RETENTION_DAYS, DEFAULTS.rawTelegramDays, 3_650),
		resultDays: positiveInt(env.JOB_RESULT_RETENTION_DAYS, DEFAULTS.resultDays, 3_650),
		errorDays: positiveInt(env.ERROR_RETENTION_DAYS, DEFAULTS.errorDays, 3_650),
		auditDays: positiveInt(env.DELETION_AUDIT_RETENTION_DAYS, DEFAULTS.auditDays, 7_300),
		stuckMinutes: positiveInt(env.STUCK_JOB_MINUTES, DEFAULTS.stuckMinutes, 1_440),
		alertLimit: positiveInt(env.ALERT_SCAN_LIMIT, DEFAULTS.alertLimit, 500),
	};
}

function adminSecretMatches(request, env) {
	const expected = String(env?.ADMIN_API_SECRET ?? "").trim();
	const received = String(request.headers.get("X-Admin-Secret") ?? "").trim();
	if (!expected || !received) return false;
	const left = new TextEncoder().encode(received);
	const right = new TextEncoder().encode(expected);
	let difference = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	return difference === 0;
}

export function isAdminAuthorized(request, env) {
	return adminSecretMatches(request, env);
}

function actorFromRequest(request) {
	return String(request.headers.get("X-Admin-Actor") ?? "operator").trim().slice(0, 200) || "operator";
}

async function recordOperationError(db, jobId, code, message, attemptNumber = 0, workspaceId = "workspace_default") {
	try {
		await db.prepare("INSERT INTO errors (job_id, stage, error_code, message, retryable, attempt_number, workspace_id) VALUES (?, 'operations', ?, ?, 0, ?, ?)").bind(jobId, code, String(message).slice(0, 500), attemptNumber, workspaceId).run();
	} catch {
		await db.prepare("INSERT INTO errors (job_id, stage, error_code, message, retryable, attempt_number) VALUES (?, 'operations', ?, ?, 0, ?)").bind(jobId, code, String(message).slice(0, 500), attemptNumber).run();
	}
}

export async function listDeadLetterJobs(db, limit = 25, workspaceId = "workspace_default") {
	const result = await db.prepare("SELECT id, workspace_id, normalized_url, status, attempt_count, provider, updated_at, created_at FROM jobs WHERE workspace_id = ? AND status = 'dead_letter' ORDER BY updated_at DESC LIMIT ?").bind(workspaceId, Math.min(Math.max(Number(limit) || 25, 1), 100)).all();
	return result?.results ?? [];
}

export async function listStuckJobs(db, env = {}, workspaceId = "workspace_default") {
	const config = retentionConfig(env);
	const result = await db.prepare("SELECT id, workspace_id, normalized_url, status, attempt_count, provider, updated_at, created_at FROM jobs WHERE workspace_id = ? AND status = 'processing' AND updated_at < datetime('now', ?) ORDER BY updated_at ASC LIMIT ?").bind(workspaceId, `-${config.stuckMinutes} minutes`, config.alertLimit).all();
	return result?.results ?? [];
}

async function recordAlert(db, alertKey, job, kind, message) {
	const result = await db.prepare("INSERT OR IGNORE INTO job_alerts (alert_key, job_id, kind, message, workspace_id) VALUES (?, ?, ?, ?, ?)").bind(alertKey, job?.id ?? null, kind, String(message).slice(0, 500), job?.workspace_id ?? "workspace_default").run();
	return Boolean(result?.meta?.changes);
}

function adminChatIds(env) {
	return String(env?.TELEGRAM_ADMIN_CHAT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 20);
}

export async function sendAdminAlert(db, job, kind, message, env, fetchImpl = fetch) {
	const alertKey = `${kind}:${job?.id ?? "global"}`;
	if (!(await recordAlert(db, alertKey, job, kind, message))) return { sent: false, duplicate: true };
	const chatIds = adminChatIds(env);
	if (!env?.TELEGRAM_BOT_TOKEN || chatIds.length === 0) return { sent: false, configured: false };
	const text = `⚠️ ${kind}\nJob: ${job?.id ?? "n/a"}${job?.normalized_url ? `\nURL: ${job.normalized_url}` : ""}\n${String(message).slice(0, 700)}`;
	let sent = 0;
	for (const chatId of chatIds) {
		try { await sendTelegramMessage(chatId, text, env, fetchImpl); sent += 1; } catch { /* D1 alert record remains the source of truth. */ }
	}
	await db.prepare("UPDATE job_alerts SET sent_at = CASE WHEN ? > 0 THEN CURRENT_TIMESTAMP ELSE sent_at END WHERE alert_key = ?").bind(sent, alertKey).run();
	return { sent: sent > 0, recipients: sent };
}

export async function markDeadLetterMessage(message, env, fetchImpl = fetch) {
	const body = message?.body;
	const jobId = typeof body?.jobId === "string" ? body.jobId : null;
	if (!jobId) {
		message?.ack?.();
		return { status: "ignored" };
	}
	const job = await env.DB.prepare("SELECT id, workspace_id, normalized_url, status, attempt_count, provider FROM jobs WHERE id = ?").bind(jobId).first();
	if (!job) {
		message?.ack?.();
		return { status: "missing", jobId };
	}
	if (job.status === "completed") {
		message?.ack?.();
		return { status: "completed", jobId };
	}
	if (job.status !== "completed" && job.status !== "dead_letter") {
		await env.DB.prepare("UPDATE jobs SET status = 'dead_letter', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'completed'").bind(jobId).run();
		await recordOperationError(env.DB, jobId, "dead_letter", "Queue delivery exhausted and moved to the dead-letter queue", job.attempt_count ?? 0, job.workspace_id);
	}
	await sendAdminAlert(env.DB, job, "dead_letter", "Queue delivery exhausted; review before replay.", env, fetchImpl);
	message?.ack?.();
	return { status: "dead_letter", jobId };
}

export async function replayDeadLetterJob(jobId, requestedBy, reason, env) {
	const job = await env.DB.prepare("SELECT id, workspace_id, normalized_url, status, attempt_count FROM jobs WHERE id = ?").bind(jobId).first();
	if (!job) return { ok: false, status: 404, error: "job_not_found" };
	if (!["dead_letter", "failed"].includes(job.status)) return { ok: false, status: 409, error: "job_not_replayable", currentStatus: job.status };
	const replayId = crypto.randomUUID();
	try {
		await env.DB.prepare("INSERT INTO job_replays (id, job_id, previous_status, requested_by, reason, workspace_id) VALUES (?, ?, ?, ?, ?, ?)").bind(replayId, job.id, job.status, String(requestedBy || "operator").slice(0, 200), String(reason || "manual replay").slice(0, 500), job.workspace_id ?? "workspace_default").run();
	} catch {
		await env.DB.prepare("INSERT INTO job_replays (id, job_id, previous_status, requested_by, reason) VALUES (?, ?, ?, ?, ?)").bind(replayId, job.id, job.status, String(requestedBy || "operator").slice(0, 200), String(reason || "manual replay").slice(0, 500)).run();
	}
	await env.DB.prepare("UPDATE jobs SET status = 'queued', attempt_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(job.id).run();
	try {
		await env.JOBS_QUEUE.send({ version: 1, jobId: job.id, correlationId: job.id, replayId, workspaceId: job.workspace_id ?? "workspace_default" }, { contentType: "json" });
	} catch (error) {
		await env.DB.prepare("UPDATE jobs SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(job.id).run();
		await recordOperationError(env.DB, job.id, "replay_publish_failed", error?.message ?? "Replay Queue publish failed", job.attempt_count ?? 0, job.workspace_id);
		return { ok: false, status: 503, error: "queue_unavailable" };
	}
	return { ok: true, status: 202, replayId, jobId: job.id };
}

export async function runRetention(db, env = {}, { dryRun = false } = {}) {
	const config = retentionConfig(env);
	const statements = [
		["raw_messages_redacted", "UPDATE jobs SET original_message = NULL, user_note = NULL WHERE created_at < datetime('now', ?) AND (original_message IS NOT NULL OR user_note IS NOT NULL)", `-${config.rawTelegramDays} days`],
		["results_redacted", "UPDATE jobs SET result_json = NULL WHERE status IN ('completed', 'failed', 'dead_letter') AND completed_at IS NOT NULL AND completed_at < datetime('now', ?) AND result_json IS NOT NULL", `-${config.resultDays} days`],
		["errors_deleted", "DELETE FROM errors WHERE created_at < datetime('now', ?)", `-${config.errorDays} days`],
		["replay_audit_deleted", "DELETE FROM job_replays WHERE created_at < datetime('now', ?)", `-${config.auditDays} days`],
		["deletion_audit_deleted", "DELETE FROM job_deletions WHERE deleted_at < datetime('now', ?)", `-${config.auditDays} days`],
	];
	if (dryRun) return { dryRun: true, config, actions: statements.map(([name]) => name) };
	const counts = {};
	for (const [name, sql, modifier] of statements) {
		const result = await db.prepare(sql).bind(modifier).run();
		counts[name] = result?.meta?.changes ?? 0;
	}
	return { dryRun: false, config, counts };
}

export async function scanStuckJobs(env, fetchImpl = fetch, workspaceId = "workspace_default") {
	const jobs = await listStuckJobs(env.DB, env, workspaceId);
	const alerts = [];
	for (const job of jobs) alerts.push(await sendAdminAlert(env.DB, job, "stuck_job", `Job has remained processing for more than ${retentionConfig(env).stuckMinutes} minutes.`, env, fetchImpl));
	return { scanned: jobs.length, alerts };
}

export async function runScheduledOperations(env, fetchImpl = fetch) {
	const retention = await runRetention(env.DB, env);
	const stuck = await scanStuckJobs(env, fetchImpl);
	return { retention, stuck };
}

export { DEFAULTS };
