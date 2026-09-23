const TOKEN_MINUTES = 15;

function json(data, status = 200) {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function base64Url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

async function hash(value) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expiresAt() { return new Date(Date.now() + TOKEN_MINUTES * 60_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""); }

async function telegramApi(method, payload, env, fetchImpl = fetch) {
	if (!env?.TELEGRAM_BOT_TOKEN) throw new Error("telegram_not_configured");
	const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
	let body = null;
	try { body = await response.json(); } catch { /* handled below */ }
	if (!response.ok || !body?.ok) throw new Error(body?.description || `telegram_${response.status}`);
	return body.result;
}

export function connectionKindForChat(chatType) { return chatType === "private" ? "private" : ["group", "supergroup"].includes(chatType) ? "group" : null; }

export async function createTelegramLinkToken(db, workspaceId, userId, botUsername, connectionKind = "any") {
	const token = randomToken();
	await db.prepare("INSERT INTO telegram_link_tokens (token_hash, workspace_id, created_by_user_id, connection_kind, expires_at) VALUES (?, ?, ?, ?, ?)").bind(await hash(token), workspaceId, userId, connectionKind, expiresAt()).run();
	const encoded = encodeURIComponent(token);
	const username = String(botUsername || "").replace(/^@/, "");
	return { token, expiresInSeconds: TOKEN_MINUTES * 60, privateUrl: username ? `https://t.me/${username}?start=${encoded}` : null, groupUrl: username ? `https://t.me/${username}?startgroup=${encoded}` : null };
}

export async function getBotUsername(env, fetchImpl = fetch) {
	if (env?.TELEGRAM_BOT_USERNAME) return String(env.TELEGRAM_BOT_USERNAME).replace(/^@/, "");
	const me = await telegramApi("getMe", {}, env, fetchImpl);
	return me?.username ? String(me.username) : null;
}

function adminStatus(status) { return status === "creator" || status === "administrator"; }

export async function connectTelegramUpdate(update, env, fetchImpl = fetch) {
	const message = update?.message;
	const text = typeof message?.text === "string" ? message.text.trim() : "";
	const match = text.match(/^\/(?:start|connect)(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{32,200}))?$/i);
	if (!match?.[1]) return null;
	const token = match[1];
	const chat = message.chat;
	const kind = connectionKindForChat(chat?.type);
	if (!kind || message?.from?.id === undefined || chat?.id === undefined) return { handled: true, status: "unsupported_chat", message: "Please use this link in a private chat or a group." };
	const tokenRow = await env.DB.prepare("SELECT token_hash, workspace_id, created_by_user_id, connection_kind FROM telegram_link_tokens WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP").bind(await hash(token)).first();
	if (!tokenRow) return { handled: true, status: "invalid_token", message: "This Telegram connection link is expired or already used. Generate a new link from setup." };
	if (tokenRow.connection_kind !== "any" && tokenRow.connection_kind !== kind) return { handled: true, status: "wrong_chat_type", message: "Use the matching private-chat or group connection link." };
	if (kind === "private" && String(message.from.id) !== String(chat.id)) return { handled: true, status: "wrong_user", message: "Open the private connection link from your own Telegram account." };
	if (kind === "group") {
		let actor;
		let bot;
		try {
			[actor, bot] = await Promise.all([
				telegramApi("getChatMember", { chat_id: chat.id, user_id: message.from.id }, env, fetchImpl),
				telegramApi("getMe", {}, env, fetchImpl),
			]);
			const botMember = await telegramApi("getChatMember", { chat_id: chat.id, user_id: bot.id }, env, fetchImpl);
			if (!adminStatus(actor?.status) || !adminStatus(botMember?.status)) return { handled: true, status: "group_authority_required", message: "You must be a group admin, and the bot must be an admin, to connect this group." };
		} catch { return { handled: true, status: "group_verification_failed", message: "Telegram could not verify the group permissions. Make sure the bot is an admin and try again." }; }
	}
	const existing = await env.DB.prepare("SELECT workspace_id, status FROM telegram_connections WHERE chat_id = ?").bind(String(chat.id)).first();
	if (existing?.status === "active" && existing.workspace_id !== tokenRow.workspace_id) return { handled: true, status: "chat_already_connected", message: "This chat is already connected to another workspace. Disconnect it there before reconnecting." };
	const consumed = await env.DB.prepare("UPDATE telegram_link_tokens SET consumed_at = CURRENT_TIMESTAMP, connected_chat_id = ? WHERE token_hash = ? AND consumed_at IS NULL").bind(String(chat.id), await hash(token)).run();
	if (!consumed.meta?.changes) return { handled: true, status: "invalid_token", message: "This Telegram connection link is expired or already used. Generate a new link from setup." };
	if (existing) {
		await env.DB.prepare("UPDATE telegram_connections SET workspace_id = ?, connected_by_user_id = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?").bind(tokenRow.workspace_id, tokenRow.created_by_user_id, String(chat.id)).run();
	} else {
		await env.DB.prepare("INSERT INTO telegram_connections (chat_id, workspace_id, connected_by_user_id, status) VALUES (?, ?, ?, 'active')").bind(String(chat.id), tokenRow.workspace_id, tokenRow.created_by_user_id).run();
	}
	return { handled: true, status: "connected", workspaceId: tokenRow.workspace_id, chatId: String(chat.id), message: kind === "group" ? "✅ This Telegram group is connected. You can now send links here." : "✅ This private chat is connected. You can now send links here." };
}

export async function sendConnectionResult(result, update, env, fetchImpl = fetch) {
	const chatId = update?.message?.chat?.id;
	if (!result?.handled || chatId === undefined || !env?.TELEGRAM_BOT_TOKEN) return;
	await telegramApi("sendMessage", { chat_id: chatId, text: result.message }, env, fetchImpl);
}

export { TOKEN_MINUTES, json as linkingJson };
