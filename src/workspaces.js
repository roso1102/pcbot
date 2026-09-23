export const DEFAULT_WORKSPACE_ID = "workspace_default";

function asChatId(chatId) {
	if (chatId === undefined || chatId === null || String(chatId).trim() === "") return null;
	return String(chatId).trim().slice(0, 200);
}

/**
 * Resolve the owner workspace for a Telegram chat. The Telegram allow-list is
 * still the admission control; this table is the durable ownership mapping.
 * Before migration 0006 exists, gracefully fall back to the legacy workspace
 * so deploys can be rolled forward without interrupting intake.
 */
export async function resolveWorkspaceForChat(db, chatId, userId = "user_legacy_owner") {
	const normalizedChatId = asChatId(chatId);
	if (!db || !normalizedChatId) return null;
	try {
		const existing = await db.prepare("SELECT workspace_id FROM telegram_connections WHERE chat_id = ? AND status = 'active'").bind(normalizedChatId).first();
		if (existing?.workspace_id) return String(existing.workspace_id);
		await db.prepare("INSERT OR IGNORE INTO telegram_connections (chat_id, workspace_id, connected_by_user_id, status) VALUES (?, ?, ?, 'active')").bind(normalizedChatId, DEFAULT_WORKSPACE_ID, userId).run();
	} catch {
		// Compatibility with a Worker briefly running before 0006 is applied.
	}
	return DEFAULT_WORKSPACE_ID;
}

export function storageUrlHash(workspaceId, canonicalHash) {
	const workspace = String(workspaceId || DEFAULT_WORKSPACE_ID);
	const hash = String(canonicalHash || "");
	return workspace === DEFAULT_WORKSPACE_ID ? hash : `${workspace}:${hash}`;
}
