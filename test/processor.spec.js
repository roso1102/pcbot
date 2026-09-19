import { describe, expect, it } from "vitest";
import { formatSuccessMessage } from "../src/processor";

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
