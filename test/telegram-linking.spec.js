import { describe, expect, it } from "vitest";
import { connectTelegramUpdate, createTelegramLinkToken, getBotUsername } from "../src/telegram-linking";

class LinkDb {
	constructor(token) { this.token = token; this.connections = new Map(); this.runs = []; this.consumed = false; }
	prepare(sql) {
		return { bind: (...values) => ({
			first: async () => {
				if (sql.includes("FROM telegram_link_tokens")) return this.consumed ? null : { token_hash: values[0], workspace_id: "workspace-1", created_by_user_id: "user-1", connection_kind: "any" };
				if (sql.includes("FROM telegram_connections")) return this.connections.get(String(values[0])) ?? null;
				return null;
			},
			run: async () => { this.runs.push({ sql, values }); if (sql.includes("SET consumed_at")) this.consumed = true; return { meta: { changes: 1 } }; },
		}) };
	}
}

describe("Phase 15 Telegram linking", () => {
	it("creates short-lived private and group links", async () => {
		const db = new LinkDb();
		const result = await createTelegramLinkToken(db, "workspace-1", "user-1", "CambrianBot");
		expect(result.privateUrl).toContain("https://t.me/CambrianBot?start=");
		expect(result.groupUrl).toContain("https://t.me/CambrianBot?startgroup=");
		expect(result.expiresInSeconds).toBe(900);
		expect(db.runs[0].values[1]).toBe("workspace-1");
	});

	it("connects a private chat and consumes the token", async () => {
		const token = "t".repeat(43);
		const db = new LinkDb(token);
		const result = await connectTelegramUpdate({ message: { text: `/start ${token}`, from: { id: 55 }, chat: { id: 55, type: "private" } } }, { DB: db, TELEGRAM_BOT_TOKEN: "bot-token" });
		expect(result).toMatchObject({ handled: true, status: "connected", chatId: "55" });
		expect(db.runs.some(({ sql }) => sql.includes("telegram_connections"))).toBe(true);
		const reused = await connectTelegramUpdate({ message: { text: `/start ${token}`, from: { id: 55 }, chat: { id: 55, type: "private" } } }, { DB: db, TELEGRAM_BOT_TOKEN: "bot-token" });
		expect(reused.status).toBe("invalid_token");
	});

	it("requires both the connecting user and bot to have group authority", async () => {
		const token = "g".repeat(43);
		const db = new LinkDb(token);
		const fetchImpl = async (_url, init) => {
			const payload = JSON.parse(init.body);
			if (payload.user_id === 7) return Response.json({ ok: true, result: { status: "member" } });
			if (payload.user_id === 99) return Response.json({ ok: true, result: { status: "administrator" } });
			return Response.json({ ok: true, result: { id: 99, username: "CambrianBot" } });
		};
		const result = await connectTelegramUpdate({ message: { text: `/start ${token}`, from: { id: 7 }, chat: { id: -100, type: "supergroup" } } }, { DB: db, TELEGRAM_BOT_TOKEN: "bot-token" }, fetchImpl);
		expect(result.status).toBe("group_authority_required");
	});

	it("connects a group when the user and bot are administrators", async () => {
		const token = "a".repeat(43);
		const db = new LinkDb(token);
		const fetchImpl = async (_url, init) => {
			const payload = JSON.parse(init.body);
			if (payload.user_id === 7 || payload.user_id === 99) return Response.json({ ok: true, result: { status: "administrator" } });
			return Response.json({ ok: true, result: { id: 99, username: "CambrianBot" } });
		};
		const result = await connectTelegramUpdate({ message: { text: `/connect ${token}`, from: { id: 7 }, chat: { id: -101, type: "group" } } }, { DB: db, TELEGRAM_BOT_TOKEN: "bot-token" }, fetchImpl);
		expect(result).toMatchObject({ handled: true, status: "connected", chatId: "-101" });
	});

	it("does not reveal or accept an expired/unknown token", async () => {
		const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
		const result = await connectTelegramUpdate({ message: { text: "/start invalidinvalidinvalidinvalidinvalidinvalid", from: { id: 1 }, chat: { id: 1, type: "private" } } }, { DB: db });
		expect(result).toMatchObject({ handled: true, status: "invalid_token" });
	});

	it("rejects a private link used from a different Telegram identity", async () => {
		const token = "p".repeat(43);
		const db = new LinkDb(token);
		const result = await connectTelegramUpdate({ message: { text: `/start ${token}`, from: { id: 1 }, chat: { id: 2, type: "private" } } }, { DB: db, TELEGRAM_BOT_TOKEN: "bot-token" });
		expect(result.status).toBe("wrong_user");
	});

	it("uses getMe only when a configured bot username is absent", async () => {
		expect(await getBotUsername({ TELEGRAM_BOT_USERNAME: "@CambrianBot" })).toBe("CambrianBot");
	});
});
