import { describe, expect, it } from "vitest";
import worker from "../src";

const secret = "bridge-secret";
const recordKey = "a".repeat(64);

class FakeActionDb {
	constructor() {
		this.job = { id: "job-1", status: "completed", record_state: "active", normalized_url: "https://example.com", url_hash: recordKey, result_json: '{"schemaVersion":1}' };
		this.deleted = [];
	}

	prepare(sql) {
		return {
			bind: (...values) => ({
				first: async () => sql.includes("SELECT id, status, record_state") ? (this.job?.url_hash === values[0] ? this.job : null) : null,
				run: async () => {
					if (sql.includes("UPDATE jobs SET record_state")) { this.job.record_state = sql.includes("record_state = 'active'") ? "active" : "archived"; return { meta: { changes: 1 } }; }
					if (sql.includes("UPDATE jobs SET result_json")) { this.job.result_json = values[0]; this.job.user_note = values[1]; return { meta: { changes: 1 } }; }
					if (sql.includes("INSERT INTO job_deletions")) { this.deleted.push(values); return { meta: { changes: 1 } }; }
					if (sql.includes("DELETE FROM jobs")) { this.job = null; return { meta: { changes: 1 } }; }
					throw new Error(`Unhandled SQL: ${sql}`);
				},
			}),
		};
	}
}

async function signEnvelope(payload) {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const payloadJson = JSON.stringify(payload);
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payloadJson}`)));
	let binary = "";
	for (const byte of digest) binary += String.fromCharCode(byte);
	const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return { timestamp, payload_json: payloadJson, signature };
}

describe("Sheet lifecycle actions", () => {
	it("archives a completed job through the signed endpoint", async () => {
		const db = new FakeActionDb();
		const body = await signEnvelope({ action: "archive", recordKey, requestedBy: "owner@example.com" });
		const response = await worker.fetch(new Request("https://example.com/sheet-action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { DB: db, GOOGLE_SHEETS_BRIDGE_SECRET: secret });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, status: "archived", jobId: "job-1" });
		expect(db.job.record_state).toBe("archived");
	});

	it("restores an archived job without reprocessing it", async () => {
		const db = new FakeActionDb();
		db.job.record_state = "archived";
		const body = await signEnvelope({ action: "restore", recordKey, requestedBy: "owner@example.com" });
		const response = await worker.fetch(new Request("https://example.com/sheet-action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { DB: db, GOOGLE_SHEETS_BRIDGE_SECRET: secret });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, status: "restored", jobId: "job-1" });
		expect(db.job.record_state).toBe("active");
	});

	it("saves validated Sheet edits into the canonical JSON", async () => {
		const db = new FakeActionDb();
		const body = await signEnvelope({ action: "save edits", recordKey, requestedBy: "owner@example.com", fields: { title: "Edited title", summary: "Edited summary", userNote: "Review this", type: "competition", deadline: "2026-11-30", tags: "AI, Climate, #AI" } });
		const response = await worker.fetch(new Request("https://example.com/sheet-action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { DB: db, GOOGLE_SHEETS_BRIDGE_SECRET: secret });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, status: "saved_edits", jobId: "job-1" });
		const result = JSON.parse(db.job.result_json);
		expect(result.extraction).toMatchObject({ title: "Edited title", type: "competition", deadline: "2026-11-30", tags: ["ai", "climate"] });
	});

	it("rejects unsigned actions", async () => {
		const response = await worker.fetch(new Request("https://example.com/sheet-action", { method: "POST", body: "{}" }), { DB: new FakeActionDb(), GOOGLE_SHEETS_BRIDGE_SECRET: secret });
		expect(response.status).toBe(401);
	});
});
