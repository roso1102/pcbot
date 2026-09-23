import { describe, expect, it } from "vitest";
import { formatSuccessMessage, processQueueMessage } from "../src/processor";

describe("Telegram success formatting", () => {
	it("uses readable HTML headings, spacing, and a source link without tags", () => {
		const message = formatSuccessMessage("https://example.com/a?x=1&y=2", {
			title: "A <special> opportunity",
			summary: "A concise summary.",
			type: "opportunity",
			tags: ["ai"],
			hashtags: ["#ai"],
			author: "Example Author",
			published_at: "2026-09-19",
			deadline: "2026-11-01",
			event: null,
		}, { status: "saved", rowNumber: 2 }, "groq");

		expect(message).toContain("<b>Title</b>");
		expect(message).toContain("A &lt;special&gt; opportunity");
		expect(message).toContain("<b>Deadline</b>: 2026-11-01");
		expect(message).toContain("<b>Source</b>: <a href=\"https://example.com/a?x=1&amp;y=2\">Open link</a>");
		expect(message).not.toContain("Tags:");
	});
});

describe("Queue redelivery", () => {
	it("acks a queue message whose workspace hint does not match D1", async () => {
		const errors = [];
		const db = {
			prepare: (sql) => ({ bind: (...values) => ({
				first: async () => sql.includes("FROM jobs") ? { id: "job-1", workspace_id: "workspace_default", status: "queued" } : null,
				run: async () => { if (sql.includes("INSERT INTO errors")) errors.push(values); return { meta: { changes: 1 } }; },
			}) }),
		};
		const message = { body: { version: 1, jobId: "job-1", workspaceId: "workspace_other" }, ack: () => { message.acked = true; }, retry: () => { message.retried = true; } };
		await processQueueMessage(message, { DB: db }, async () => new Response());
		expect(message.acked).toBe(true);
		expect(message.retried).not.toBe(true);
		expect(errors.length).toBe(1);
	});

	it("acknowledges a redelivered completed job without reprocessing", async () => {
		let fetched = false;
		const db = {
			prepare: () => ({ bind: () => ({ first: async () => ({ id: "job-1", status: "completed" }) }) }),
		};
		const message = { body: { version: 1, jobId: "job-1" }, ack: () => { message.acked = true; }, retry: () => { message.retried = true; } };
		await processQueueMessage(message, { DB: db }, async () => { fetched = true; return new Response(); });
		expect(message.acked).toBe(true);
		expect(message.retried).not.toBe(true);
		expect(fetched).toBe(false);
	});
});
