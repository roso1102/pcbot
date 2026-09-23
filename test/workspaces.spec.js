import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_ID, resolveWorkspaceForChat, storageUrlHash } from "../src/workspaces";

describe("Phase 13 workspace ownership", () => {
	it("preserves legacy storage hashes for the owner workspace", () => {
		expect(storageUrlHash(DEFAULT_WORKSPACE_ID, "a".repeat(64))).toBe("a".repeat(64));
	});

	it("namespaces storage hashes for another workspace", () => {
		const hash = "b".repeat(64);
		expect(storageUrlHash("workspace_other", hash)).toBe(`workspace_other:${hash}`);
		expect(storageUrlHash("workspace_other", hash)).not.toBe(storageUrlHash(DEFAULT_WORKSPACE_ID, hash));
	});

	it("resolves an existing connection and rejects unknown chats", async () => {
		const calls = [];
		const db = {
			prepare(sql) {
				return { bind: (...values) => ({
					first: async () => sql.includes("SELECT workspace_id") ? (values[0] === "existing" ? { workspace_id: "workspace_other" } : null) : null,
					run: async () => { calls.push({ sql, values }); return { meta: { changes: 1 } }; },
				}) };
			},
		};
		expect(await resolveWorkspaceForChat(db, "existing")).toBe("workspace_other");
		expect(await resolveWorkspaceForChat(db, "legacy-chat")).toBeNull();
		expect(calls.some(({ sql, values }) => sql.includes("telegram_connections") && values[0] === "legacy-chat")).toBe(false);
	});

	it("falls back safely while the workspace migration is not yet present", async () => {
		const db = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("no such table"); }, run: async () => { throw new Error("no such table"); } }) }) };
		expect(await resolveWorkspaceForChat(db, "legacy-chat")).toBe(DEFAULT_WORKSPACE_ID);
	});
});
