import { buildExtractionPrompt, CONTENT_TYPES, GeminiError, validateExtraction } from "./gemini";

// Llama 3.1 is fast and supports JSON Object Mode. Strict JSON Schema mode
// remains available for GPT-OSS/Qwen models when explicitly selected.
const DEFAULT_MODEL = "llama-3.1-8b-instant";
const GROQ_TIMEOUT_MS = 45000;
const MAX_GROQ_CONTENT_CHARS = 40_000;

const GROQ_EXTRACTION_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		title: { type: "string" },
		summary: { type: "string" },
		post_body: { type: "string" },
		hashtags: { type: "array", items: { type: "string" } },
		tags: { type: "array", items: { type: "string" } },
		type: { type: "string", enum: CONTENT_TYPES },
		deadline: { type: ["string", "null"] },
		author: { type: ["string", "null"] },
		author_profile_url: { type: ["string", "null"] },
		published_at: { type: ["string", "null"] },
		event: {
			type: ["object", "null"],
			additionalProperties: false,
			properties: {
				name: { type: ["string", "null"] },
				start_at: { type: ["string", "null"] },
				end_at: { type: ["string", "null"] },
				timezone: { type: ["string", "null"] },
				location: { type: ["string", "null"] },
				url: { type: ["string", "null"] },
			},
			required: ["name", "start_at", "end_at", "timezone", "location", "url"],
		},
		confidence_notes: { type: "string" },
	},
	required: ["title", "summary", "post_body", "hashtags", "tags", "type", "deadline", "author", "author_profile_url", "published_at", "event", "confidence_notes"],
};

function supportsStrictSchema(model) {
	return model.startsWith("openai/gpt-oss-") || model.startsWith("qwen/qwen3.8-");
}

export function trimForGroq(value) {
	const text = String(value ?? "");
	if (text.length <= MAX_GROQ_CONTENT_CHARS) return text;
	// Keep the beginning for title/author context and the end for deadlines,
	// application links, and event details commonly placed after the body.
	const headChars = 28_000;
	const tailChars = MAX_GROQ_CONTENT_CHARS - headChars;
	return `${text.slice(0, headChars)}\n\n[...middle of page omitted for Groq payload safety...]\n\n${text.slice(-tailChars)}`;
}

export class GroqError extends Error {
	constructor(code, message, retryable = false, status = undefined) {
		super(message);
		this.name = "GroqError";
		this.code = code;
		this.retryable = retryable;
		this.provider = "groq";
		this.status = status;
	}
}

export async function extractWithGroq(sourceUrl, cleanedContent, env, fetchImpl = fetch) {
	if (!env?.GROQ_API_KEY) throw new GroqError("not_configured", "Groq is not configured");
	const model = env.GROQ_MODEL || DEFAULT_MODEL;
	const boundedContent = trimForGroq(cleanedContent);
	const prompt = buildExtractionPrompt(sourceUrl, boundedContent) + "\nReturn only one valid JSON object. Do not include markdown fences. Include every requested field; use null for missing nullable fields and [] for missing arrays.";
	let response;
	let timeoutId;
	const controller = typeof AbortController === "function" ? new AbortController() : null;
	try {
		if (controller) timeoutId = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
		response = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
			body: JSON.stringify({ model, messages: [{ role: "system", content: "You extract structured data and return JSON only." }, { role: "user", content: prompt }], temperature: 0, max_completion_tokens: 2048, response_format: supportsStrictSchema(model) ? { type: "json_schema", json_schema: { name: "link_extraction", strict: true, schema: GROQ_EXTRACTION_SCHEMA } } : { type: "json_object" } }),
			signal: controller?.signal,
		});
	} catch (error) {
		const timedOut = error?.name === "AbortError";
		throw new GroqError(timedOut ? "timeout" : "network_error", timedOut ? "Groq request timed out" : (error?.message ?? "Groq request failed"), true);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
	if (!response.ok) {
		let providerMessage = "";
		try {
			const errorPayload = await response.clone().json();
			providerMessage = typeof errorPayload?.error?.message === "string" ? errorPayload.error.message.slice(0, 300) : "";
		} catch {
			// Keep the status code as the stable diagnostic when the provider body is not JSON.
		}
		throw new GroqError(`groq_http_${response.status}`, `Groq returned HTTP ${response.status} for ${model} (${boundedContent.length} input chars)${providerMessage ? `: ${providerMessage}` : ""}`, [408, 425, 429, 500, 502, 503, 504].includes(response.status), response.status);
	}
	let payload;
	try { payload = await response.json(); } catch { throw new GroqError("invalid_json", "Groq returned invalid JSON"); }
	const text = payload?.choices?.[0]?.message?.content ?? "";
	try {
		return validateExtraction(JSON.parse(text));
	} catch (error) {
		if (error instanceof GeminiError) throw new GroqError(error.code, error.message, false);
		throw new GroqError("invalid_json_output", "Groq output was not valid JSON");
	}
}
