const DEFAULT_TIMEOUT_MS = 20_000;
// Keep model prompts bounded. 60k characters is usually enough for a post/article
// while avoiding accidental token-heavy requests from long navigation pages.
const MAX_CONTENT_CHARS = 60_000;
const UI_NOISE = /^(like|comment|share|repost|send|follow|following|connect|message|more|view profile|see translation|show translation|hide translation|report this post|all activity|notifications?)\b/i;

export class PageReadError extends Error {
	constructor(code, message, retryable = false, provider = "unknown", status = undefined) {
		super(message);
		this.name = "PageReadError";
		this.code = code;
		this.retryable = retryable;
		this.provider = provider;
		this.status = status;
	}
}

function repairMojibake(value) {
	const replacements = {
		"Ã©": "é", "Ã¨": "è", "Ã¡": "á", "Ã³": "ó", "Ãº": "ú", "Ã±": "ñ",
		"â€™": "’", "â€œ": "“", "â€": "”", "â€“": "–", "â€”": "—", "â€¦": "…", "Â·": "·", "Â ": " ",
	};
	let text = value;
	for (const [bad, good] of Object.entries(replacements)) text = text.split(bad).join(good);
	return text;
}

export function cleanForGemini(value) {
	const normalized = repairMojibake(String(value ?? "")).normalize("NFKC").replace(/\u0000/g, "").replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");
	return normalized.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !UI_NOISE.test(line)).join("\n").slice(0, MAX_CONTENT_CHARS);
}

function trimContent(content, provider) {
	const cleaned = cleanForGemini(content);
	if (!cleaned) throw new PageReadError("empty_content", `${provider} returned no readable content`, false, provider);
	return cleaned;
}

async function requestWithTimeout(fetchImpl, input, init, timeoutMs) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(input, { ...init, signal: controller.signal });
	} catch (error) {
		if (error?.name === "AbortError") throw new PageReadError("timeout", "Page reader request timed out", true);
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function providerError(provider, response) {
	const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
	return new PageReadError(`${provider}_http_${response.status}`, `${provider} returned HTTP ${response.status}`, retryable, provider, response.status);
}

function extractContent(payload) {
	const first = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
	const result = Array.isArray(payload?.results) ? payload.results[0] : undefined;
	return result?.text ?? result?.markdown ?? result?.content ?? first?.text ?? first?.markdown ?? first?.content ?? payload?.markdown ?? payload?.content ?? (typeof first === "string" ? first : undefined);
}

async function readWithTinyFish(url, apiKey, fetchImpl, timeoutMs) {
	const response = await requestWithTimeout(fetchImpl, "https://api.fetch.tinyfish.ai", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", "X-API-Key": apiKey },
		body: JSON.stringify({ urls: [url] }),
	}, timeoutMs);
	if (!response.ok) throw providerError("tinyfish", response);
	let payload;
	try { payload = await response.json(); } catch { throw new PageReadError("tinyfish_invalid_json", "TinyFish returned invalid JSON", false, "tinyfish", response.status); }
	return { provider: "tinyfish", content: trimContent(extractContent(payload), "TinyFish"), status: response.status };
}

async function readWithFirecrawl(url, apiKey, fetchImpl, timeoutMs) {
	const response = await requestWithTimeout(fetchImpl, "https://api.firecrawl.dev/v2/scrape", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ url, formats: ["markdown"] }),
	}, timeoutMs);
	if (!response.ok) throw providerError("firecrawl", response);
	let payload;
	try { payload = await response.json(); } catch { throw new PageReadError("firecrawl_invalid_json", "Firecrawl returned invalid JSON", false, "firecrawl", response.status); }
	return { provider: "firecrawl", content: trimContent(extractContent(payload), "Firecrawl"), status: response.status };
}

export async function readPage(url, env, fetchImpl = fetch) {
	const timeoutMs = Number(env?.PAGE_READER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
	const started = Date.now();
	let primaryError;
	if (env?.TINYFISH_API_KEY) {
		try { return { ...(await readWithTinyFish(url, env.TINYFISH_API_KEY, fetchImpl, timeoutMs)), url, latencyMs: Date.now() - started }; }
		catch (error) { primaryError = error; }
	}
	if (env?.FIRECRAWL_API_KEY) {
		try { return { ...(await readWithFirecrawl(url, env.FIRECRAWL_API_KEY, fetchImpl, timeoutMs)), url, latencyMs: Date.now() - started, fallbackFrom: primaryError?.code }; }
		catch (fallbackError) { if (primaryError) fallbackError.cause = primaryError.code; throw fallbackError; }
	}
	if (primaryError) throw primaryError;
	throw new PageReadError("provider_not_configured", "TinyFish is not configured");
}
