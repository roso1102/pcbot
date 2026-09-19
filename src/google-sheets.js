export const SHEET_HEADERS = [
	"timestamp", "title", "original_message", "link", "summary", "user_note", "type", "deadline", "tags", "shared_by_name", "shared_by_username", "action", "_record_key",
];

export const STATUS_HEADERS = ["updated_at", "job_id", "url_hash", "source_url", "status", "attempt_count", "provider", "message", "main_row_number"];
export const FAILURE_HEADERS = ["failure_key", "recorded_at", "job_id", "url_hash", "source_url", "attempt_number", "code", "message", "retryable", "provider_status"];

export class GoogleSheetsError extends Error {
	constructor(code, message, retryable = false, status = undefined) {
		super(message);
		this.name = "GoogleSheetsError";
		this.code = code;
		this.retryable = retryable;
		this.provider = "google_sheets_bridge";
		this.status = status;
		this.stage = "google_sheets";
	}
}

function base64UrlEncode(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signPayload(payload, secret) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return base64UrlEncode(new Uint8Array(signature));
}

export function buildSheetRow(job, extraction, provider, processedAt = new Date().toISOString()) {
	const tags = extraction.tags?.length ? extraction.tags : extraction.hashtags.map((tag) => tag.replace(/^#+/, "").toLowerCase());
	return [job.created_at ?? processedAt, extraction.title ?? extraction.event?.name ?? "Untitled", job.original_message ?? "", job.normalized_url, extraction.summary, job.user_note ?? "", extraction.type ?? "other", extraction.type === "grant" ? extraction.deadline ?? "" : "", tags.join(", "), job.sender_name ?? "", job.sender_username ? `@${String(job.sender_username).replace(/^@/, "")}` : "", "", job.url_hash];
}

export function findExistingSheetRow(rows, urlHash) {
	for (let index = 1; index < rows.length; index += 1) if (rows[index]?.[12] === urlHash) return index + 1;
	return null;
}

async function parseBridgeResponse(response) {
	let payload;
	try { payload = await response.json(); } catch { throw new GoogleSheetsError("invalid_json", "Sheets bridge returned invalid JSON", true); }
	if (!response.ok) throw new GoogleSheetsError(`bridge_http_${response.status}`, `Sheets bridge returned HTTP ${response.status}`, [408, 425, 429, 500, 502, 503, 504].includes(response.status), response.status);
	if (!payload?.ok) {
		const debugSuffix = typeof payload?.debug_code === "string" ? `_${payload.debug_code}` : "";
		throw new GoogleSheetsError(`${payload?.error ?? "bridge_error"}${debugSuffix}`, "Sheets bridge rejected the write", false, response.status);
	}
	if (!Number.isInteger(payload.rowNumber) || payload.rowNumber < 2) throw new GoogleSheetsError("row_number_missing", "Sheets bridge did not return a valid row number", true);
	return payload;
}

async function sendBridgePayload(payload, env, fetchImpl) {
	if (!env?.GOOGLE_SHEETS_BRIDGE_URL || !env?.GOOGLE_SHEETS_BRIDGE_SECRET) throw new GoogleSheetsError("not_configured", "Google Sheets bridge is not configured");
	const payloadJson = JSON.stringify(payload);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = await signPayload(`${timestamp}.${payloadJson}`, String(env.GOOGLE_SHEETS_BRIDGE_SECRET).trim());
	let response;
	try {
		response = await fetchImpl(env.GOOGLE_SHEETS_BRIDGE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timestamp, payload_json: payloadJson, signature }) });
	} catch (error) { throw new GoogleSheetsError("network_error", error?.message ?? "Sheets bridge request failed", true); }
	const result = await parseBridgeResponse(response);
	return result;
}

export async function syncJobToSheets(job, extraction, provider, env, fetchImpl = fetch) {
	const result = await sendBridgePayload({ kind: "main", urlHash: job.url_hash, row: buildSheetRow(job, extraction, provider) }, env, fetchImpl);
	return { status: "saved", rowNumber: result.rowNumber, alreadyExisted: result.status === "already_saved" };
}

export async function syncStatusToSheets(job, status, provider, message, env, fetchImpl = fetch, mainRowNumber = null) {
	const row = [new Date().toISOString(), job.id, job.url_hash, job.normalized_url, status, job.attempt_count ?? 0, provider ?? "", String(message ?? "").slice(0, 500), mainRowNumber ?? ""];
	const result = await sendBridgePayload({ kind: "status", key: job.id, row }, env, fetchImpl);
	return { status: "saved", rowNumber: result.rowNumber };
}

export async function recordFailureToSheets(job, error, env, fetchImpl = fetch) {
	const attemptNumber = error.attemptNumber ?? job.attempt_count ?? 0;
	const code = error.code ?? "processor_error";
	const row = [`${job.id}:${attemptNumber}:${code}`, new Date().toISOString(), job.id, job.url_hash, job.normalized_url, attemptNumber, code, String(error.message ?? "Processing failed").slice(0, 500), error.retryable ? "true" : "false", error.status ?? ""];
	const result = await sendBridgePayload({ kind: "failure", key: row[0], row }, env, fetchImpl);
	return { status: "saved", rowNumber: result.rowNumber };
}
