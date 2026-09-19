import { describe, it, expect } from "vitest";
import { cleanForGemini, readPage } from "../src/page-reader";

function mockFetch(response) {
	return async () => response;
}

describe("TinyFish page reader", () => {
	it("reads clean page content through TinyFish", async () => {
		const response = new Response(JSON.stringify({ results: [{ url: "https://www.linkedin.com/posts/example", format: "markdown", text: "Author\nLike\nActual post body\n#event" }], errors: [] }), { status: 200 });
		const result = await readPage("https://www.linkedin.com/posts/example", { TINYFISH_API_KEY: "tinyfish-test" }, mockFetch(response));
		expect(result.provider).toBe("tinyfish");
		expect(result.content).toContain("Actual post body");
		expect(result.content).not.toContain("Like");
	});

	it("uses Firecrawl only as an optional fallback", async () => {
		const fetchImpl = async () => new Response(JSON.stringify({ data: { markdown: "Firecrawl fallback" } }), { status: 200 });
		const result = await readPage("https://example.com", { FIRECRAWL_API_KEY: "firecrawl-test" }, fetchImpl);
		expect(result.provider).toBe("firecrawl");
	});

	it("falls back to Firecrawl only when TinyFish fails and a Firecrawl key exists", async () => {
		let call = 0;
		const fetchImpl = async () => call++ === 0 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ data: { markdown: "fallback content" } }), { status: 200 });
		const result = await readPage("https://example.com", { TINYFISH_API_KEY: "tinyfish-test", FIRECRAWL_API_KEY: "firecrawl-test" }, fetchImpl);
		expect(result.provider).toBe("firecrawl");
		expect(result.fallbackFrom).toBe("tinyfish_http_503");
	});

	it("classifies TinyFish rate limits as retryable", async () => {
		await expect(readPage("https://example.com", { TINYFISH_API_KEY: "tinyfish-test" }, mockFetch(new Response("busy", { status: 429 })))).rejects.toMatchObject({ code: "tinyfish_http_429", retryable: true });
	});

	it("repairs common mojibake and removes LinkedIn UI noise", () => {
		const cleaned = cleanForGemini("JosÃ© â€“ event â€™26\nLike\nComment\nView Profile\n[Event page](https://example.com/event)\n#launch");
		expect(cleaned).toContain("José – event ’26");
		expect(cleaned).toContain("#launch");
		expect(cleaned).toContain("Event page (https://example.com/event)");
		expect(cleaned).not.toContain("Comment");
	});

	it("rejects missing providers and caps content", async () => {
		await expect(readPage("https://example.com", {}, mockFetch(new Response()))).rejects.toMatchObject({ code: "provider_not_configured" });
		const result = await readPage("https://example.com", { TINYFISH_API_KEY: "tinyfish-test" }, mockFetch(new Response(JSON.stringify({ data: [{ markdown: "x".repeat(250_000) }] }), { status: 200 })));
		expect(result.content.length).toBe(60_000);
	});
});
