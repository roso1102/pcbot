import { processQueueMessage } from "./processor";
import { sendTelegramMessage } from "./telegram";

const SERVICE_NAME = "telegram-link-bot";
const MAX_TELEGRAM_BODY_BYTES = 1_000_000;

function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...headers },
	});
}

function constantTimeEqual(left, right) {
	if (typeof left !== "string" || typeof right !== "string") return false;
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	const length = Math.max(leftBytes.length, rightBytes.length);
	let difference = leftBytes.length ^ rightBytes.length;
	for (let index = 0; index < length; index += 1) {
		difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return difference === 0;
}

function normalizeUrl(value) {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hostname = url.hostname.toLowerCase();
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		if (isUnsafeHostname(hostname)) return null;
		if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
		url.hash = "";
		return url.toString();
	} catch {
		return null;
	}
}

function isUnsafeHostname(hostname) {
	const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal")) return true;
	if (value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return true;
	const octets = value.split(".").map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
	return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}

function extractUrls(update) {
	const candidates = [];
	const messages = [update?.message, update?.edited_message, update?.channel_post, update?.edited_channel_post];
	for (const message of messages) {
		if (!message) continue;
		if (typeof message.text === "string") candidates.push(...(message.text.match(/https?:\/\/[^\s<>"']+/gi) ?? []));
		if (typeof message.caption === "string") candidates.push(...(message.caption.match(/https?:\/\/[^\s<>"']+/gi) ?? []));
		for (const entity of [...(message.entities ?? []), ...(message.caption_entities ?? [])]) {
			if (entity?.type === "text_link" && typeof entity.url === "string") candidates.push(entity.url);
		}
	}
	const normalized = [];
	for (const candidate of candidates) {
		const url = normalizeUrl(candidate.replace(/[),.;!?]+$/g, ""));
		if (url && !normalized.includes(url)) normalized.push(url);
	}
	return normalized;
}

function getTelegramMessages(update) {
	return [update?.message, update?.edited_message, update?.channel_post, update?.edited_channel_post].filter(Boolean);
}

function getChatId(update) {
	return getTelegramMessages(update)[0]?.chat?.id;
}

function getOriginalMessage(message) {
	return typeof message?.text === "string" ? message.text : typeof message?.caption === "string" ? message.caption : "";
}

function getUserNote(message) {
	const note = getOriginalMessage(message).replace(/https?:\/\/[^\s<>"']+/gi, "").replace(/\s+/g, " ").trim();
	return note || null;
}

function getSenderName(message) {
	const from = message?.from ?? {};
	return [from.first_name, from.last_name].filter((value) => typeof value === "string" && value.trim()).join(" ") || null;
}

function getSenderUsername(message) {
	return typeof message?.from?.username === "string" ? message.from.username : null;
}

function toHex(bytes) {
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashUrl(url) {
	return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
}

function allowedChat(env, chatId) {
	const configured = env?.TELEGRAM_ALLOWED_CHAT_IDS;
	if (!configured) return true;
	const allowed = String(configured).split(",").map((value) => value.trim()).filter(Boolean);
	return chatId !== undefined && allowed.includes(String(chatId));
}

async function recordError(db, jobId, stage, errorCode, message, retryable = false) {
	if (!db || !jobId) return;
	await db.prepare("INSERT INTO errors (job_id, stage, error_code, message, retryable) VALUES (?, ?, ?, ?, ?)").bind(jobId, stage, errorCode, String(message).slice(0, 500), retryable ? 1 : 0).run();
}

function base64UrlEncode(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function verifySignedSheetAction(request, env) {
	const secret = String(env?.GOOGLE_SHEETS_BRIDGE_SECRET ?? "").trim();
	if (!secret) return { ok: false, status: 503, error: "sheet_action_not_configured" };
	let envelope;
	try { envelope = await request.json(); } catch { return { ok: false, status: 400, error: "invalid_json" }; }
	if (!envelope || typeof envelope.timestamp !== "string" || typeof envelope.payload_json !== "string" || typeof envelope.signature !== "string") return { ok: false, status: 401, error: "unauthorized" };
	const timestamp = Number(envelope.timestamp);
	if (!Number.isInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return { ok: false, status: 401, error: "unauthorized" };
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${envelope.timestamp}.${envelope.payload_json}`));
	if (!constantTimeEqual(base64UrlEncode(new Uint8Array(digest)), envelope.signature)) return { ok: false, status: 401, error: "unauthorized" };
	try { return { ok: true, payload: JSON.parse(envelope.payload_json) }; } catch { return { ok: false, status: 400, error: "invalid_payload" }; }
}

async function handleSheetAction(request, env) {
	if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "POST" });
	const verification = await verifySignedSheetAction(request, env);
	if (!verification.ok) return json({ ok: false, error: verification.error }, verification.status);
	const payload = verification.payload;
	const action = String(payload?.action ?? "").trim().toLowerCase();
	const recordKey = String(payload?.recordKey ?? "").trim();
	const requestedBy = String(payload?.requestedBy ?? "sheet-user").slice(0, 200);
	if (!["archive", "restore", "delete"].includes(action) || !/^[a-f0-9]{64}$/i.test(recordKey)) return json({ ok: false, error: "invalid_action" }, 400);
	const job = await env.DB.prepare("SELECT id, status, record_state, normalized_url, url_hash, result_json FROM jobs WHERE url_hash = ?").bind(recordKey).first();
	if (!job) return json({ ok: false, error: "job_not_found" }, 404);
	if (job.status === "processing" || job.status === "queued") return json({ ok: false, error: "job_in_progress" }, 409);
	if (action === "restore") {
		if (job.record_state !== "archived") return json({ ok: true, status: "already_active", jobId: job.id });
		await env.DB.prepare("UPDATE jobs SET record_state = 'active', state_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(job.id).run();
		return json({ ok: true, status: "restored", jobId: job.id });
	}
	if (action === "archive") {
		await env.DB.prepare("UPDATE jobs SET record_state = 'archived', state_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(job.id).run();
		return json({ ok: true, status: "archived", jobId: job.id });
	}
	await env.DB.prepare("INSERT INTO job_deletions (job_id, url_hash, normalized_url, result_json, deleted_by) VALUES (?, ?, ?, ?, ?)").bind(job.id, job.url_hash, job.normalized_url, job.result_json ?? null, requestedBy).run();
	await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(job.id).run();
	return json({ ok: true, status: "deleted", jobId: job.id });
}

async function enqueueJobs(update, urls, env) {
	const updateId = Number(update.update_id);
	if (!Number.isSafeInteger(updateId)) return { error: "update_id_required" };
	const message = getTelegramMessages(update)[0];
	const chatId = getChatId(update);
	const originalMessage = getOriginalMessage(message);
	const userNote = getUserNote(message);
	const senderName = getSenderName(message);
	const senderUsername = getSenderUsername(message);
	if (!allowedChat(env, chatId)) return { error: "chat_not_allowed" };
	const queued = [];
	const queuedJobs = [];
	const duplicates = [];
	const duplicateJobs = [];
	const retries = [];
	for (const [urlIndex, normalizedUrl] of urls.entries()) {
		const urlHash = await hashUrl(normalizedUrl);
		const jobId = crypto.randomUUID();
		const insert = await env.DB.prepare(`
			INSERT OR IGNORE INTO jobs
			(id, telegram_update_id, url_index, chat_id, message_id, original_url, normalized_url, url_hash, original_message, user_note, sender_name, sender_username)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(jobId, updateId, urlIndex, chatId === undefined ? null : String(chatId), message?.message_id ?? null, normalizedUrl, normalizedUrl, urlHash, originalMessage, userNote, senderName, senderUsername).run();
		let selectedJobId = jobId;
		if (!insert.meta?.changes) {
			const existing = await env.DB.prepare("SELECT id, status, record_state FROM jobs WHERE url_hash = ?").bind(urlHash).first();
			selectedJobId = existing?.id;
			duplicates.push(normalizedUrl);
			if (selectedJobId) {
				const notice = { url: normalizedUrl, jobId: selectedJobId, status: existing.record_state === "archived" ? "archived" : existing.status };
				if (existing.status === "failed") retries.push(notice);
				else duplicateJobs.push(notice);
			}
			if (!selectedJobId || ["completed", "queued", "processing", "dead_letter"].includes(existing.status)) continue;
		}
		try {
			let progressMessageId = null;
			if (env?.TELEGRAM_BOT_TOKEN && chatId !== undefined && chatId !== null) {
				try {
					const progress = await sendTelegramMessage(chatId, `⏳ Queued for processing:\n${normalizedUrl}`, env);
					progressMessageId = progress.messageId;
				} catch {
					// A progress message is optional; the queued job must still be accepted.
				}
			}
			await env.JOBS_QUEUE.send({ version: 1, jobId: selectedJobId, correlationId: selectedJobId, progressMessageId }, { contentType: "json" });
			if (!duplicates.includes(normalizedUrl)) {
				queued.push(normalizedUrl);
				queuedJobs.push({ jobId: selectedJobId, url: normalizedUrl, progressMessageId });
			}
		} catch (error) {
			await recordError(env.DB, selectedJobId, "queue", "queue_publish_failed", error?.message ?? "Queue publish failed", true);
			return { error: "queue_unavailable" };
		}
	}
	return { queued, queuedJobs, duplicates, duplicateJobs, retries };
}

async function handleTelegram(request, env, ctx) {
	if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "POST" });
	const expectedSecret = env?.TELEGRAM_WEBHOOK_SECRET;
	const receivedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
	if (!constantTimeEqual(receivedSecret ?? "", expectedSecret ?? "")) return json({ ok: false, error: "unauthorized" }, 401);
	const contentLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_TELEGRAM_BODY_BYTES) return json({ ok: false, error: "payload_too_large" }, 413);
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().startsWith("application/json")) return json({ ok: false, error: "content_type_required" }, 415);
	let update;
	try {
		const body = await request.text();
		if (new TextEncoder().encode(body).byteLength > MAX_TELEGRAM_BODY_BYTES) return json({ ok: false, error: "payload_too_large" }, 413);
		update = JSON.parse(body);
	} catch {
		return json({ ok: false, error: "invalid_json" }, 400);
	}
	if (!update || typeof update !== "object" || Array.isArray(update)) return json({ ok: false, error: "invalid_update" }, 400);
	const urls = extractUrls(update);
	if (!Number.isSafeInteger(Number(update.update_id))) return json({ ok: false, error: "update_id_required" }, 400);
	if (!allowedChat(env, getChatId(update))) return json({ ok: false, error: "chat_not_allowed" }, 403);
	if (env?.DB && env?.JOBS_QUEUE && urls.length > 0) {
		try {
			const result = await enqueueJobs(update, urls, env);
			if (result.error === "queue_unavailable") return json({ ok: false, error: result.error }, 503);
			if ((result.duplicateJobs?.length || result.retries?.length) && env?.TELEGRAM_BOT_TOKEN && ctx?.waitUntil) {
				const duplicateText = result.duplicateJobs.map(({ url, jobId, status }) => `Already saved or in progress:\n${url}\nJob: ${jobId}\nStatus: ${status}`);
				const retryText = result.retries.map(({ url, jobId }) => `Previous attempt failed; retrying:\n${url}\nJob: ${jobId}`);
				ctx.waitUntil(sendTelegramMessage(getChatId(update), [...duplicateText, ...retryText].join("\n\n"), env).catch(() => undefined));
			}
			return json({ ok: true, status: "queued", queued: result.queued, duplicates: result.duplicates, retries: result.retries.map(({ url }) => url) });
		} catch (error) {
			return json({ ok: false, error: "intake_failed" }, 500);
		}
	}
	return json({ ok: true, status: urls.length > 0 ? "received" : "ignored", ...(urls.length > 0 ? { urls } : { reason: "no_supported_url" }) });
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "GET" });
			return json({ ok: true, service: SERVICE_NAME });
		}
		if (url.pathname === "/telegram") return handleTelegram(request, env, ctx);
		if (url.pathname === "/sheet-action") return handleSheetAction(request, env);
		return json({ ok: false, error: "not_found" }, 404);
	},

	async queue(batch, env) {
		for (const message of batch.messages) await processQueueMessage(message, env);
	},
};
