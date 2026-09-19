import { buildExtractionPrompt, GeminiError, validateExtraction } from "./gemini";

const DEFAULT_MODEL = "openai/gpt-oss-20b";
const GROQ_TIMEOUT_MS = 45000;

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
	const prompt = buildExtractionPrompt(sourceUrl, cleanedContent) + "\nReturn only one valid JSON object. Do not include markdown fences.";
	let response;
	let timeoutId;
	const controller = typeof AbortController === "function" ? new AbortController() : null;
	try {
		if (controller) timeoutId = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
		response = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
			body: JSON.stringify({ model, messages: [{ role: "system", content: "You extract structured data and return JSON only." }, { role: "user", content: prompt }], temperature: 0.1, max_tokens: 2048, response_format: { type: "json_object" } }),
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
			providerMessage = typeof errorPayload?.error?.message === "string" ? errorPayload.error.message.slice(0, 180) : "";
		} catch {
			// Keep the status code as the stable diagnostic when the provider body is not JSON.
		}
		throw new GroqError(`groq_http_${response.status}`, `Groq returned HTTP ${response.status}${providerMessage ? `: ${providerMessage}` : ""}`, [408, 425, 429, 500, 502, 503, 504].includes(response.status), response.status);
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
