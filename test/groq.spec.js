import { describe, expect, it } from "vitest";
import { extractWithGroq } from "../src/groq";

const extraction = {
	title: "Launch invitation",
	summary: "A launch invitation.",
	post_body: "Join us for the launch.",
	hashtags: ["#launch"],
	tags: ["launch", "event"],
	type: "event",
	deadline: null,
	author: "Alex Example",
	author_profile_url: null,
	published_at: null,
	event: null,
	confidence_notes: "Date was explicit.",
};

function mockFetch(payload, status = 200) {
	return async (url, init) => {
		expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
		expect(init.headers.Authorization).toBe("Bearer groq-test");
		const requestBody = JSON.parse(init.body);
		expect(requestBody.response_format.type).toBe("json_schema");
		expect(requestBody.response_format.json_schema.strict).toBe(true);
		expect(requestBody.response_format.json_schema.schema.properties.type.enum).toContain("competition");
		return new Response(JSON.stringify(payload), { status });
	};
}

describe("Groq fallback extraction", () => {
	it("parses the same structured extraction shape", async () => {
		const result = await extractWithGroq("https://example.com", "post text", { GROQ_API_KEY: "groq-test" }, mockFetch({ choices: [{ message: { content: JSON.stringify(extraction) } }] }));
		expect(result.title).toBe("Launch invitation");
		expect(result.tags).toEqual(["launch", "event"]);
	});

	it("marks provider rate limits as retryable", async () => {
		await expect(extractWithGroq("https://example.com", "post text", { GROQ_API_KEY: "groq-test" }, mockFetch({}, 429))).rejects.toMatchObject({ code: "groq_http_429", retryable: true });
	});
});
