export class TelegramError extends Error {
	constructor(code, message, retryable = false, status = undefined) {
		super(message);
		this.name = "TelegramError";
		this.code = code;
		this.retryable = retryable;
		this.provider = "telegram";
		this.status = status;
		this.stage = "telegram";
	}
}

async function callTelegram(method, payload, env, fetchImpl = fetch) {
	if (!env?.TELEGRAM_BOT_TOKEN || payload?.chat_id === null || payload?.chat_id === undefined) return { skipped: true };
	const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!response.ok) throw new TelegramError(`telegram_http_${response.status}`, `Telegram returned HTTP ${response.status}`, [408, 429, 500, 502, 503, 504].includes(response.status), response.status);
	let data = null;
	if (typeof response.json === "function") {
		try { data = await response.json(); } catch { data = null; }
	}
	if (data && data.ok === false) throw new TelegramError(`telegram_${data.error_code ?? "api_error"}`, data.description ?? "Telegram API request failed", [429, 500, 502, 503, 504].includes(data.error_code));
	return { skipped: false, result: data?.result };
}

export async function sendTelegramMessage(chatId, text, env, fetchImpl = fetch) {
	const response = await callTelegram("sendMessage", { chat_id: chatId, text: String(text).slice(0, 4096), disable_web_page_preview: true }, env, fetchImpl);
	return { ...response, messageId: response.result?.message_id ?? null };
}

export async function editTelegramMessage(chatId, messageId, text, env, fetchImpl = fetch) {
	if (messageId === null || messageId === undefined) return { skipped: true };
	return callTelegram("editMessageText", { chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4096), disable_web_page_preview: true }, env, fetchImpl);
}

export async function sendTelegramChatAction(chatId, env, fetchImpl = fetch) {
	return callTelegram("sendChatAction", { chat_id: chatId, action: "typing" }, env, fetchImpl);
}
