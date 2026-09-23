import { describe, it, expect } from "vitest";
import worker from "../src";

const secret = "test-webhook-secret";
const env = { TELEGRAM_WEBHOOK_SECRET: secret };

class FakeD1 {
	constructor() {
		this.jobs = new Map();
		this.errors = [];
		this.connections = new Map();
	}

	prepare(sql) {
		return {
			bind: (...values) => ({
				run: async () => {
					if (sql.includes("INSERT OR IGNORE INTO telegram_connections")) { this.connections.set(values[0], values[1]); return { meta: { changes: 1 } }; }
					if (sql.includes("INSERT OR IGNORE INTO jobs")) {
						const [id, workspaceId, updateId, urlIndex, chatId, messageId, originalUrl, normalizedUrl, urlHash, canonicalHash] = values;
						if ([...this.jobs.values()].some((job) => (job.workspace_id === workspaceId && job.canonical_url_hash === canonicalHash) || (job.workspace_id === workspaceId && job.telegram_update_id === updateId && job.url_index === urlIndex))) return { meta: { changes: 0 } };
						this.jobs.set(id, { id, workspace_id: workspaceId, telegram_update_id: updateId, url_index: urlIndex, chat_id: chatId, message_id: messageId, original_url: originalUrl, normalized_url: normalizedUrl, url_hash: urlHash, canonical_url_hash: canonicalHash, status: "queued", record_state: "active" });
						return { meta: { changes: 1 } };
					}
					if (sql.includes("INSERT INTO errors")) {
						this.errors.push(values);
						return { meta: { changes: 1 } };
					}
					throw new Error(`Unhandled fake SQL: ${sql}`);
				},
				first: async () => {
					if (sql.includes("FROM telegram_connections")) return this.connections.has(values[0]) ? { workspace_id: this.connections.get(values[0]) } : null;
					if (sql.includes("SELECT id, status, record_state FROM jobs WHERE url_hash") || sql.includes("SELECT id, status, record_state FROM jobs WHERE workspace_id")) {
						const job = sql.includes("workspace_id = ?") ? [...this.jobs.values()].find((item) => item.workspace_id === values[0] && item.canonical_url_hash === values[1]) : [...this.jobs.values()].find((item) => item.url_hash === values[0]);
						return job ? { id: job.id, status: job.status, record_state: job.record_state } : null;
					}
					return null;
				},
			}),
		};
	}
}

class FakeQueue {
	messages = [];

	async send(message) {
		this.messages.push(message);
	}
}

async function request(path, init = {}) {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

describe("routing", () => {
	it("returns a stable health response", async () => {
		const response = await request("/health");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ ok: true, service: "telegram-link-bot" });
	});

	it("returns 404 for unknown routes", async () => {
		const response = await request("/unknown");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, error: "not_found" });
	});

	it("returns 405 for a wrong method", async () => {
		const response = await request("/health", { method: "POST" });
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET");
	});
});

describe("telegram intake", () => {
	const telegramInit = (body, headers = {}) => ({
		method: "POST",
		headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret, ...headers },
		body,
	});

	it("rejects missing or incorrect webhook secrets", async () => {
		const body = JSON.stringify({ update_id: 1, message: { text: "https://example.com" } });
		const missing = await request("/telegram", { method: "POST", headers: { "content-type": "application/json" }, body });
		const incorrect = await request("/telegram", telegramInit(body, { "X-Telegram-Bot-Api-Secret-Token": "wrong" }));
		expect(missing.status).toBe(401);
		expect(incorrect.status).toBe(401);
		expect(await missing.json()).toEqual({ ok: false, error: "unauthorized" });
	});

	it("rejects malformed JSON and unsupported content types", async () => {
		const malformed = await request("/telegram", telegramInit("not-json"));
		const wrongType = await request("/telegram", telegramInit("{}", { "content-type": "text/plain" }));
		expect(malformed.status).toBe(400);
		expect(wrongType.status).toBe(415);
	});

	it("normalizes and deduplicates URLs from a Telegram message", async () => {
		const body = JSON.stringify({ update_id: 2, message: { text: "Read https://Example.com:443/path#section and https://example.com/path#other!" } });
		const response = await request("/telegram", telegramInit(body));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, status: "received", urls: ["https://example.com/path"] });
	});

	it("acknowledges an update with no URL without claiming it was queued", async () => {
		const response = await request("/telegram", telegramInit(JSON.stringify({ update_id: 3, message: { text: "hello" } })));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, status: "ignored", reason: "no_supported_url" });
	});

	it("returns 405 for a wrong method on the Telegram route", async () => {
		const response = await request("/telegram", { method: "GET" });
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	it("persists and queues each URL when D1 and Queue bindings are available", async () => {
		const db = new FakeD1();
		const queue = new FakeQueue();
		const body = JSON.stringify({ update_id: 10, message: { message_id: 7, chat: { id: 42 }, text: "https://example.com/a https://example.com/b" } });
		const response = await worker.fetch(new Request("https://example.com/telegram", telegramInit(body)), { ...env, DB: db, JOBS_QUEUE: queue });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, status: "queued", queued: ["https://example.com/a", "https://example.com/b"], duplicates: [] });
		expect(db.jobs.size).toBe(2);
		expect(queue.messages).toHaveLength(2);
		expect(queue.messages[0]).toMatchObject({ version: 1, correlationId: queue.messages[0].jobId });
	});

	it("deduplicates a normalized URL across Telegram updates", async () => {
		const db = new FakeD1();
		const queue = new FakeQueue();
		const first = JSON.stringify({ update_id: 11, message: { chat: { id: 42 }, text: "https://example.com/a#one" } });
		const second = JSON.stringify({ update_id: 12, message: { chat: { id: 42 }, text: "https://EXAMPLE.com:443/a#two" } });
		await worker.fetch(new Request("https://example.com/telegram", telegramInit(first)), { ...env, DB: db, JOBS_QUEUE: queue });
		const response = await worker.fetch(new Request("https://example.com/telegram", telegramInit(second)), { ...env, DB: db, JOBS_QUEUE: queue });
		expect(await response.json()).toMatchObject({ ok: true, status: "queued", queued: [], duplicates: ["https://example.com/a"] });
		expect(db.jobs.size).toBe(1);
		expect(queue.messages).toHaveLength(1);
	});

	it("allows the same canonical URL in separate workspaces", async () => {
		const db = new FakeD1();
		db.connections.set("other-chat", "workspace_other");
		const queue = new FakeQueue();
		const first = JSON.stringify({ update_id: 111, message: { chat: { id: 42 }, text: "https://example.com/shared" } });
		const second = JSON.stringify({ update_id: 111, message: { chat: { id: "other-chat" }, text: "https://example.com/shared" } });
		await worker.fetch(new Request("https://example.com/telegram", telegramInit(first)), { ...env, DB: db, JOBS_QUEUE: queue });
		const response = await worker.fetch(new Request("https://example.com/telegram", telegramInit(second)), { ...env, DB: db, JOBS_QUEUE: queue });
		expect(await response.json()).toMatchObject({ status: "queued", queued: ["https://example.com/shared"], duplicates: [] });
		expect(db.jobs.size).toBe(2);
		expect(new Set([...db.jobs.values()].map((job) => job.workspace_id))).toEqual(new Set(["workspace_default", "workspace_other"]));
	});

	it("treats a repeated Telegram update as harmless", async () => {
		const db = new FakeD1();
		const queue = new FakeQueue();
		const body = JSON.stringify({ update_id: 14, message: { chat: { id: 42 }, text: "https://example.com/repeated" } });
		const first = await worker.fetch(new Request("https://example.com/telegram", telegramInit(body)), { ...env, DB: db, JOBS_QUEUE: queue });
		const second = await worker.fetch(new Request("https://example.com/telegram", telegramInit(body)), { ...env, DB: db, JOBS_QUEUE: queue });
		expect(await first.json()).toMatchObject({ status: "queued", queued: ["https://example.com/repeated"] });
		expect(await second.json()).toMatchObject({ status: "queued", queued: [], duplicates: ["https://example.com/repeated"] });
		expect(db.jobs.size).toBe(1);
		expect(queue.messages).toHaveLength(1);
	});

	it("keeps concurrent submissions of one URL deterministic", async () => {
		const db = new FakeD1();
		const queue = new FakeQueue();
		const firstBody = JSON.stringify({ update_id: 15, message: { chat: { id: 42 }, text: "https://example.com/concurrent" } });
		const secondBody = JSON.stringify({ update_id: 16, message: { chat: { id: 42 }, text: "https://example.com/concurrent#fragment" } });
		const responses = await Promise.all([
			worker.fetch(new Request("https://example.com/telegram", telegramInit(firstBody)), { ...env, DB: db, JOBS_QUEUE: queue }),
			worker.fetch(new Request("https://example.com/telegram", telegramInit(secondBody)), { ...env, DB: db, JOBS_QUEUE: queue }),
		]);
		const payloads = await Promise.all(responses.map((response) => response.json()));
		expect(db.jobs.size).toBe(1);
		expect(queue.messages).toHaveLength(1);
		expect(payloads.some((payload) => payload.queued?.length === 1)).toBe(true);
		expect(payloads.some((payload) => payload.duplicates?.length === 1)).toBe(true);
	});

	it("ignores obvious private or local URLs", async () => {
		const body = JSON.stringify({ update_id: 13, message: { text: "http://127.0.0.1/admin http://localhost/test http://192.168.1.2/" } });
		const response = await request("/telegram", telegramInit(body));
		expect(await response.json()).toEqual({ ok: true, status: "ignored", reason: "no_supported_url" });
	});
});
