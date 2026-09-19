import { describe, it, expect } from "vitest";
import { extractWithGemini } from "../src/gemini";

const extraction = {
	title: "Launch invitation",
	summary: "A launch invitation.",
	post_body: "Join us for the launch.",
	hashtags: ["#launch", "#launch"],
	tags: ["AI", "#launch"],
	type: "event",
	deadline: null,
	author: "Alex Example",
	author_profile_url: "https://www.linkedin.com/in/alex",
	published_at: "2026-09-19T10:00:00Z",
	event: { name: "Launch", start_at: "2026-10-01T18:00:00Z", end_at: null, timezone: "UTC", location: "Online", url: "https://example.com/event" },
	confidence_notes: "Date was explicit.",
};

function mockFetch(payload, status = 200) {
	return async (url, init) => {
		expect(url).toContain("generateContent");
		expect(init.headers["x-goog-api-key"]).toBe("gemini-test");
		const requestBody = JSON.parse(init.body);
		expect(requestBody.generationConfig.response_mime_type).toBe("application/json");
		expect(requestBody.generationConfig.maxOutputTokens).toBe(2048);
		expect(requestBody.generationConfig.response_schema).toBeTruthy();
		return new Response(JSON.stringify(payload), { status });
	};
}

describe("Gemini extraction", () => {
	it("parses and normalizes structured output", async () => {
		const result = await extractWithGemini("https://example.com/post", "Actual post body\n#launch", { GEMINI_API_KEY: "gemini-test" }, mockFetch({ candidates: [{ content: { parts: [{ text: JSON.stringify(extraction) }] } }] }));
		expect(result.hashtags).toEqual(["#launch"]);
		expect(result.tags).toEqual(["ai", "launch"]);
		expect(result.type).toBe("event");
		expect(result.post_body).toBe("Join us for the launch.");
	});

	it("rejects malformed model output", async () => {
		await expect(extractWithGemini("https://example.com", "text", { GEMINI_API_KEY: "gemini-test" }, mockFetch({ candidates: [{ content: { parts: [{ text: "not-json" }] } }] }))).rejects.toMatchObject({ code: "invalid_json_output" });
	});

	it("classifies rate limits as retryable", async () => {
		await expect(extractWithGemini("https://example.com", "text", { GEMINI_API_KEY: "gemini-test" }, mockFetch({}, 429))).rejects.toMatchObject({ code: "gemini_http_429", retryable: true });
	});

	it("does not retry an exhausted quota", async () => {
		const quotaResponse = { error: { message: "You exceeded your current quota, please check your plan and billing details." } };
		await expect(extractWithGemini("https://example.com", "text", { GEMINI_API_KEY: "gemini-test" }, mockFetch(quotaResponse, 429))).rejects.toMatchObject({ code: "gemini_http_429", retryable: false });
	});
});
