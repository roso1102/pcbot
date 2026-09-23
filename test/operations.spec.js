import { describe, expect, it } from "vitest";
import worker from "../src";
import { markDeadLetterMessage, replayDeadLetterJob, runRetention, scanStuckJobs } from "../src/operations";

const adminSecret = "phase12-admin-secret";

class OperationsDb {
	constructor(status = "dead_letter") {
		this.jobs = new Map([["job-1", { id: "job-1", normalized_url: "https://example.com", status, attempt_count: 4, provider: "groq", updated_at: "2026-09-24 00:00:00", created_at: "2026-09-24 00:00:00" }]]);
		this.replays = [];
		this.alerts = [];
		this.errors = [];
		this.runs = [];
	}

	prepare(sql) {
		return {
			bind: (...values) => ({
				first: async () => {
					if (sql.includes("FROM jobs WHERE id = ?")) return this.jobs.get(values[0]) ?? null;
					return null;
				},
				all: async () => {
					if (sql.includes("status = 'dead_letter'")) return { results: [...this.jobs.values()].filter((job) => job.status === "dead_letter") };
					if (sql.includes("status = 'processing'")) return { results: [...this.jobs.values()].filter((job) => job.status === "processing") };
					return { results: [] };
				},
				run: async () => {
					this.runs.push({ sql, values });
					if (sql.includes("INSERT INTO job_replays")) this.replays.push({ id: values[0], jobId: values[1], previousStatus: values[2] });
					if (sql.includes("UPDATE jobs SET status = 'queued'")) this.jobs.get(values[0]).status = "queued";
					if (sql.includes("UPDATE jobs SET status = 'failed'")) this.jobs.get(values[0]).status = "failed";
					if (sql.includes("UPDATE jobs SET status = 'dead_letter'")) this.jobs.get(values[0]).status = "dead_letter";
					if (sql.includes("attempt_count = 0")) this.jobs.get(values[0]).attempt_count = 0;
					if (sql.includes("INSERT INTO errors")) this.errors.push(values);
					if (sql.includes("INSERT OR IGNORE INTO job_alerts")) {
						if (this.alerts.some((alert) => alert.key === values[0])) return { meta: { changes: 0 } };
						this.alerts.push({ key: values[0], jobId: values[1], kind: values[2], message: values[3] });
					}
					return { meta: { changes: 1 } };
				},
			}),
		};
	}
}

class Queue {
	constructor() { this.messages = []; }
	async send(body) { this.messages.push(body); }
}

describe("Phase 12 operations", () => {
	it("requires the admin secret for DLQ inspection", async () => {
		const response = await worker.fetch(new Request("https://example.com/admin/dlq"), { DB: new OperationsDb(), ADMIN_API_SECRET: adminSecret });
		expect(response.status).toBe(401);
	});

	it("replays a dead-letter job once and records an audit row", async () => {
		const db = new OperationsDb();
		const queue = new Queue();
		const result = await replayDeadLetterJob("job-1", "owner", "provider recovered", { DB: db, JOBS_QUEUE: queue });
		expect(result).toMatchObject({ ok: true, status: 202, jobId: "job-1" });
		expect(db.jobs.get("job-1")).toMatchObject({ status: "queued", attempt_count: 0 });
		expect(db.replays).toHaveLength(1);
		expect(queue.messages[0]).toMatchObject({ version: 1, jobId: "job-1", replayId: result.replayId });
		const second = await replayDeadLetterJob("job-1", "owner", "duplicate click", { DB: db, JOBS_QUEUE: queue });
		expect(second).toMatchObject({ ok: false, status: 409, error: "job_not_replayable" });
	});

	it("marks DLQ delivery durable and deduplicates the alert", async () => {
		const db = new OperationsDb("failed");
		const message = { body: { version: 1, jobId: "job-1" }, ack: () => { message.acked = true; } };
		const env = { DB: db, TELEGRAM_BOT_TOKEN: "", TELEGRAM_ADMIN_CHAT_IDS: "" };
		await markDeadLetterMessage(message, env);
		await markDeadLetterMessage(message, env);
		expect(db.jobs.get("job-1").status).toBe("dead_letter");
		expect(db.errors).toHaveLength(1);
		expect(db.alerts).toHaveLength(1);
		expect(message.acked).toBe(true);
	});

	it("supports a dry-run retention report without mutating D1", async () => {
		const db = new OperationsDb();
		const result = await runRetention(db, { RAW_TELEGRAM_RETENTION_DAYS: "30", JOB_RESULT_RETENTION_DAYS: "180" }, { dryRun: true });
		expect(result).toMatchObject({ dryRun: true, config: { rawTelegramDays: 30, resultDays: 180 } });
		expect(result.actions).toContain("raw_messages_redacted");
		expect(db.runs).toHaveLength(0);
	});

	it("records one alert for a stuck job and suppresses duplicate scans", async () => {
		const db = new OperationsDb("processing");
		const env = { DB: db, STUCK_JOB_MINUTES: "15", TELEGRAM_BOT_TOKEN: "", TELEGRAM_ADMIN_CHAT_IDS: "" };
		const first = await scanStuckJobs(env);
		const second = await scanStuckJobs(env);
		expect(first.scanned).toBe(1);
		expect(second.scanned).toBe(1);
		expect(db.alerts).toHaveLength(1);
	});

	it("executes all retention actions when not in dry-run mode", async () => {
		const db = new OperationsDb();
		const result = await runRetention(db, {}, { dryRun: false });
		expect(result.dryRun).toBe(false);
		expect(Object.keys(result.counts)).toHaveLength(7);
		expect(db.runs).toHaveLength(7);
	});
});
