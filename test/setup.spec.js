import { describe, expect, it } from "vitest";
import worker from "../src";
import { normalizeSpreadsheetReference, safeReturnTo } from "../src/setup";

async function hash(value) {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class SetupDb {
	constructor() {
		this.sessionToken = "s".repeat(43);
		this.csrfToken = "c".repeat(32);
		this.sessionHash = null;
		this.csrfHash = null;
		this.sheet = null;
		this.runs = [];
		this.expired = false;
		this.denied = false;
	}

	async init() {
		this.sessionHash = await hash(this.sessionToken);
		this.csrfHash = await hash(this.csrfToken);
	}

	prepare(sql) {
		return { bind: (...values) => ({
			first: async () => {
				if (sql.includes("FROM auth_sessions")) return values[0] === this.sessionHash && !this.expired && !this.denied ? { session_hash: this.sessionHash, user_id: "user-1", workspace_id: "workspace-1", csrf_hash: this.csrfHash, expires_at: "2099-01-01 00:00:00", display_name: "Test Owner", email: "owner@example.com", workspace_name: "Test Workspace", workspace_status: "active", role: "owner" } : null;
				if (sql.includes("FROM workspaces WHERE id")) return { id: "workspace-1", name: "Test Workspace", status: "active" };
				if (sql.includes("FROM google_connections")) return this.sheet;
				if (sql.includes("COUNT(*) AS count")) return { count: 0 };
				return null;
			},
			all: async () => ({ results: [] }),
			run: async () => { this.runs.push({ sql, values }); if (sql.includes("google_connections")) this.sheet = { status: "active", external_reference: values[1] }; return { meta: { changes: 1 } }; },
		}) };
	}
}

describe("Phase 14 setup", () => {
	it("normalizes a Google Sheet link without asking for a service-account key", () => {
		expect(normalizeSpreadsheetReference("https://docs.google.com/spreadsheets/d/abc_DEF-12345678901234567890/edit#gid=0")).toBe("abc_DEF-12345678901234567890");
		expect(normalizeSpreadsheetReference("not-a-sheet")).toBeNull();
	});

	it("only accepts local setup return paths", () => {
		expect(safeReturnTo("/setup?step=sheet")).toBe("/setup?step=sheet");
		expect(safeReturnTo("https://evil.example")).toBe("/setup");
		expect(safeReturnTo("//evil.example")).toBe("/setup");
	});

	it("renders a safe sign-in page when OAuth is not configured", async () => {
		const db = new SetupDb();
		await db.init();
		const response = await worker.fetch(new Request("https://example.com/setup"), { DB: db });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Google sign-in is not configured yet");
	});

	it("creates a one-time OAuth state and validates the redirect target", async () => {
		const db = new SetupDb();
		await db.init();
		const response = await worker.fetch(new Request("https://example.com/auth/google/start?return_to=https%3A%2F%2Fevil.example"), { DB: db, GOOGLE_OAUTH_CLIENT_ID: "client-id", GOOGLE_OAUTH_CLIENT_SECRET: "client-secret", APP_BASE_URL: "https://bot.example" });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toContain("accounts.google.com/o/oauth2/v2/auth");
		expect(db.runs[0].values[2]).toBe("/setup");
	});

	it("requires a session and CSRF token for Sheet changes", async () => {
		const db = new SetupDb();
		await db.init();
		const unauthenticated = await worker.fetch(new Request("https://example.com/api/setup"), { DB: db });
		expect(unauthenticated.status).toBe(401);
		const cookie = `tlb_session=${db.sessionToken}`;
		const badCsrf = await worker.fetch(new Request("https://example.com/api/setup/sheet", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ spreadsheet: "abc_DEF-12345678901234567890", csrf_token: "wrong" }) }), { DB: db });
		expect(badCsrf.status).toBe(403);
		const goodCsrf = await worker.fetch(new Request("https://example.com/api/setup/sheet", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ spreadsheet: "https://docs.google.com/spreadsheets/d/abc_DEF-12345678901234567890/edit", csrf_token: db.csrfToken }) }), { DB: db });
		expect(goodCsrf.status).toBe(200);
		expect(db.sheet.external_reference).toBe("abc_DEF-12345678901234567890");
	});

	it("rejects expired or wrong-workspace sessions without revealing setup data", async () => {
		const expiredDb = new SetupDb();
		await expiredDb.init();
		expiredDb.expired = true;
		const expired = await worker.fetch(new Request("https://example.com/api/setup", { headers: { cookie: `tlb_session=${expiredDb.sessionToken}` } }), { DB: expiredDb });
		expect(expired.status).toBe(401);
		const wrongWorkspaceDb = new SetupDb();
		await wrongWorkspaceDb.init();
		wrongWorkspaceDb.denied = true;
		const wrongWorkspace = await worker.fetch(new Request("https://example.com/api/setup", { headers: { cookie: `tlb_session=${wrongWorkspaceDb.sessionToken}` } }), { DB: wrongWorkspaceDb });
		expect(wrongWorkspace.status).toBe(401);
	});

	it("supports logout and rejects an OAuth state mismatch", async () => {
		const db = new SetupDb();
		await db.init();
		const logout = await worker.fetch(new Request("https://example.com/auth/logout", { headers: { cookie: `tlb_session=${db.sessionToken}` } }), { DB: db });
		expect(logout.status).toBe(302);
		expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
		const mismatch = await worker.fetch(new Request("https://example.com/auth/google/callback?state=badbadbadbadbadbadbadbadbadbadbadbad&code=abc"), { DB: db, GOOGLE_OAUTH_CLIENT_ID: "client-id", GOOGLE_OAUTH_CLIENT_SECRET: "client-secret" });
		expect(mismatch.status).toBe(400);
		expect(await mismatch.json()).toEqual({ ok: false, error: "oauth_state_invalid" });
	});
});
