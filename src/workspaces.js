export const DEFAULT_WORKSPACE_ID = "workspace_default";

function asChatId(chatId) {
	if (chatId === undefined || chatId === null || String(chatId).trim() === "") return null;
	return String(chatId).trim().slice(0, 200);
}

/**
 * Resolve the owner workspace for a Telegram chat. The Telegram allow-list is
 * still the admission control; this table is the durable ownership mapping.
 * Unknown chats are deliberately not auto-registered: they must use the
 * Phase 15 single-use connection flow. Before migration 0006 exists, the
 * compatibility fallback keeps the legacy Worker readable during rollout.
 */
export async function resolveWorkspaceForChat(db, chatId, userId = "user_legacy_owner") {
	const normalizedChatId = asChatId(chatId);
	if (!db || !normalizedChatId) return null;
	try {
		const existing = await db.prepare("SELECT workspace_id FROM telegram_connections WHERE chat_id = ? AND status = 'active'").bind(normalizedChatId).first();
		if (existing?.workspace_id) return String(existing.workspace_id);
		return null;
	} catch (error) {
		// Compatibility with a Worker briefly running before 0006 is applied;
		// fail closed for any other database error.
		if (!/no such table|telegram_connections/i.test(String(error?.message ?? error))) return null;
		return DEFAULT_WORKSPACE_ID;
	}
}

export function storageUrlHash(workspaceId, canonicalHash) {
	const workspace = String(workspaceId || DEFAULT_WORKSPACE_ID);
	const hash = String(canonicalHash || "");
	return workspace === DEFAULT_WORKSPACE_ID ? hash : `${workspace}:${hash}`;
}
