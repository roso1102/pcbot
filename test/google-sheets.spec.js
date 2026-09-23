import { describe, expect, it } from "vitest";
import { SHEET_HEADERS, buildSheetRow, findExistingSheetRow, syncJobToSheets } from "../src/google-sheets";

const job = { id: "job-1", url_hash: "hash-1", normalized_url: "https://example.com/post" };
const extraction = {
	title: "Launch invitation",
	summary: "A launch invitation.",
	post_body: "Join us for the launch.",
	hashtags: ["#launch", "#event"],
	tags: ["launch", "event"],
	type: "event",
	deadline: null,
	author: "Alex Example",
	author_profile_url: "https://www.linkedin.com/in/alex",
	published_at: "2026-09-19T10:00:00Z",
	event: { name: "Launch", start_at: "2026-10-01T18:00:00Z", end_at: null, timezone: "UTC", location: "Online", url: "https://example.com/event" },
	confidence_notes: "Date was explicit.",
};

describe("Google Sheets row mapping", () => {
	it("keeps a stable header and row order", () => {
		const row = buildSheetRow(job, extraction, "tinyfish+gemini", "2026-09-19T12:00:00Z");
		expect(SHEET_HEADERS).toHaveLength(13);
		expect(row).toHaveLength(SHEET_HEADERS.length);
		expect(row.slice(1, 9)).toEqual(["Launch invitation", "", "https://example.com/post", "A launch invitation.", "", "event", "", "launch, event"]);
		expect(row[11]).toBe("");
		expect(row[12]).toBe("hash-1");
	});

	it("finds an existing row by URL hash", () => {
		const rows = [SHEET_HEADERS, ["old", "old title", "", "", "", "", "", "", "", "", "", "", "hash-old"], ["now", "title", "", "", "", "", "", "", "", "", "", "", "hash-1"]];
		expect(findExistingSheetRow(rows, "hash-1")).toBe(3);
		expect(findExistingSheetRow(rows, "missing")).toBeNull();
	});

	it("writes deadlines for any classified type", () => {
		const row = buildSheetRow(job, { ...extraction, type: "competition", deadline: "2026-11-30" }, "tinyfish+gemini");
		expect(row[6]).toBe("competition");
		expect(row[7]).toBe("2026-11-30");
	});

	it("classifies partial bridge failures as retryable without inventing a row", async () => {
		const failedResponse = () => new Response(JSON.stringify({ ok: false, error: "temporary" }), { status: 503 });
		await expect(syncJobToSheets(job, extraction, "tinyfish+groq", { GOOGLE_SHEETS_BRIDGE_URL: "https://bridge.example", GOOGLE_SHEETS_BRIDGE_SECRET: "bridge-secret" }, failedResponse)).rejects.toMatchObject({ code: "bridge_http_503", retryable: true });
	});
});
