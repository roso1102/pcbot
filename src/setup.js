import { createTelegramLinkToken, getBotUsername } from "./telegram-linking";

const SESSION_COOKIE = "tlb_session";
const SESSION_DAYS = 7;
const OAUTH_STATE_MINUTES = 10;
const FRESH_AUTH_MINUTES = 15;

function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function base64Url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(bytes = 32) {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return base64Url(value);
}

async function sha256(value) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isoAfterMinutes(minutes) { return new Date(Date.now() + minutes * 60_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""); }
function isoAfterDays(days) { return new Date(Date.now() + days * 86_400_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""); }

function cookieValue(request, name) {
	const cookies = String(request.headers.get("Cookie") ?? "").split(";");
	for (const cookie of cookies) {
		const [key, ...rest] = cookie.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}

function sessionCookie(token, maxAge = SESSION_DAYS * 86_400) {
	return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function safeReturnTo(value) {
	const candidate = String(value ?? "/setup");
	return candidate.startsWith("/setup") && !candidate.startsWith("//") && !/[\r\n]/.test(candidate) ? candidate : "/setup";
}

function appBaseUrl(request, env) {
	const configured = String(env?.APP_BASE_URL ?? "").trim().replace(/\/$/, "");
	if (configured) {
		try {
			const url = new URL(configured);
			if (url.protocol === "https:" || url.hostname === "localhost") return url.toString().replace(/\/$/, "");
		} catch { /* fall back to the request origin */ }
	}
	return new URL(request.url).origin;
}

function oauthConfigured(env) { return Boolean(String(env?.GOOGLE_OAUTH_CLIENT_ID ?? "").trim() && String(env?.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim()); }

export function normalizeSpreadsheetReference(value) {
	const raw = String(value ?? "").trim();
	if (!raw) return null;
	let id = raw;
	try {
		const url = new URL(raw);
		const match = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
		if (!match || url.hostname !== "docs.google.com") return null;
		id = match[1];
	} catch { /* accept an ID below */ }
	return /^[a-zA-Z0-9_-]{20,200}$/.test(id) ? id : null;
}

export async function getSession(request, db) {
	const raw = cookieValue(request, SESSION_COOKIE);
	if (!raw || !/^[A-Za-z0-9_-]{32,200}$/.test(raw)) return null;
	const hash = await sha256(raw);
	const session = await db.prepare(`
		SELECT s.session_hash, s.user_id, s.workspace_id, s.csrf_hash, s.created_at, s.expires_at,
		       u.display_name, u.email, w.name AS workspace_name, w.status AS workspace_status,
		       wm.role
		FROM auth_sessions s
		JOIN users u ON u.id = s.user_id
		JOIN workspaces w ON w.id = s.workspace_id
		JOIN workspace_members wm ON wm.workspace_id = s.workspace_id AND wm.user_id = s.user_id
		WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
	`).bind(hash).first();
	if (!session || session.workspace_status !== "active" || !["owner", "admin"].includes(session.role)) return null;
	return { ...session, rawToken: raw };
}

async function requireSession(request, env) {
	if (!env?.DB) return { ok: false, response: json({ ok: false, error: "setup_not_configured" }, 503) };
	const session = await getSession(request, env.DB);
	return session ? { ok: true, session } : { ok: false, response: json({ ok: false, error: "login_required" }, 401) };
}

function isFreshAuthentication(session) {
	if (!session?.created_at) return true;
	const created = Date.parse(`${session.created_at.replace(" ", "T")}Z`);
	return Number.isFinite(created) && Date.now() - created <= FRESH_AUTH_MINUTES * 60_000;
}

async function csrfValid(request, session, body = null) {
	const provided = String(request.headers.get("X-CSRF-Token") ?? body?.csrf_token ?? "");
	return Boolean(provided) && (await sha256(provided)) === session.csrf_hash;
}

async function rotateCsrf(db, session) {
	const token = randomToken(24);
	await db.prepare("UPDATE auth_sessions SET csrf_hash = ?, last_seen_at = CURRENT_TIMESTAMP WHERE session_hash = ?").bind(await sha256(token), session.session_hash).run();
	return token;
}

async function createWorkspaceForUser(db, user) {
	const existing = await db.prepare("SELECT w.id, w.name, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.user_id = ? AND w.status = 'active' ORDER BY wm.created_at LIMIT 1").bind(user.id).first();
	if (existing) return existing;
	const workspaceId = `workspace_${crypto.randomUUID().replaceAll("-", "")}`;
	const workspaceName = `${user.display_name || user.email || "My"} workspace`.slice(0, 120);
	await db.prepare("INSERT INTO workspaces (id, name, status) VALUES (?, ?, 'active')").bind(workspaceId, workspaceName).run();
	await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(workspaceId, user.id).run();
	await db.prepare("INSERT INTO workspace_settings (workspace_id) VALUES (?)").bind(workspaceId).run();
	return { id: workspaceId, name: workspaceName, role: "owner" };
}

async function upsertGoogleUser(db, profile) {
	const externalSubject = String(profile.sub ?? "").trim();
	if (!externalSubject || externalSubject.length > 250) throw new Error("google_subject_missing");
	const existing = await db.prepare("SELECT id, display_name, email FROM users WHERE external_subject = ?").bind(externalSubject).first();
	if (existing) {
		await db.prepare("UPDATE users SET display_name = ?, email = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(String(profile.name ?? existing.display_name ?? "Google user").slice(0, 200), String(profile.email ?? existing.email ?? "").slice(0, 320) || null, String(profile.picture ?? "").slice(0, 1000) || null, existing.id).run();
		return { ...existing, display_name: String(profile.name ?? existing.display_name ?? "Google user").slice(0, 200), email: String(profile.email ?? existing.email ?? "").slice(0, 320) || null };
	}
	const user = { id: `user_${crypto.randomUUID().replaceAll("-", "")}`, display_name: String(profile.name ?? "Google user").slice(0, 200), email: String(profile.email ?? "").slice(0, 320) || null };
	await db.prepare("INSERT INTO users (id, external_subject, display_name, email, avatar_url) VALUES (?, ?, ?, ?, ?)").bind(user.id, externalSubject, user.display_name, user.email, String(profile.picture ?? "").slice(0, 1000) || null).run();
	return user;
}

async function createSession(db, user, workspace) {
	const rawSession = randomToken(32);
	const csrf = randomToken(24);
	await db.prepare("INSERT INTO auth_sessions (session_hash, user_id, workspace_id, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?)").bind(await sha256(rawSession), user.id, workspace.id, await sha256(csrf), isoAfterDays(SESSION_DAYS)).run();
	return { rawSession, csrf };
}

export async function handleGoogleStart(request, env) {
	if (!oauthConfigured(env)) return json({ ok: false, error: "google_oauth_not_configured" }, 503);
	const url = new URL(request.url);
	const state = randomToken(32);
	const redirectUri = `${appBaseUrl(request, env)}/auth/google/callback`;
	await env.DB.prepare("INSERT INTO oauth_states (state_hash, redirect_uri, return_to, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(state), redirectUri, safeReturnTo(url.searchParams.get("return_to")), isoAfterMinutes(OAUTH_STATE_MINUTES)).run();
	const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	auth.searchParams.set("client_id", String(env.GOOGLE_OAUTH_CLIENT_ID).trim());
	auth.searchParams.set("redirect_uri", redirectUri);
	auth.searchParams.set("response_type", "code");
	auth.searchParams.set("scope", "openid email profile");
	auth.searchParams.set("state", state);
	auth.searchParams.set("prompt", url.searchParams.get("reauth") === "1" ? "login" : "select_account");
	return Response.redirect(auth.toString(), 302);
}

export async function handleGoogleCallback(request, env, fetchImpl = fetch) {
	if (!oauthConfigured(env)) return json({ ok: false, error: "google_oauth_not_configured" }, 503);
	const url = new URL(request.url);
	const state = String(url.searchParams.get("state") ?? "");
	const code = String(url.searchParams.get("code") ?? "");
	if (!/^[A-Za-z0-9_-]{32,200}$/.test(state) || !code || code.length > 4000) return json({ ok: false, error: "oauth_request_invalid" }, 400);
	const stateRow = await env.DB.prepare("SELECT state_hash, redirect_uri, return_to FROM oauth_states WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP").bind(await sha256(state)).first();
	if (!stateRow) return json({ ok: false, error: "oauth_state_invalid" }, 400);
	await env.DB.prepare("UPDATE oauth_states SET consumed_at = CURRENT_TIMESTAMP WHERE state_hash = ? AND consumed_at IS NULL").bind(stateRow.state_hash).run();
	let tokenResponse;
	try {
		tokenResponse = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: String(env.GOOGLE_OAUTH_CLIENT_ID).trim(), client_secret: String(env.GOOGLE_OAUTH_CLIENT_SECRET).trim(), redirect_uri: stateRow.redirect_uri, grant_type: "authorization_code" }) });
	} catch { return json({ ok: false, error: "oauth_provider_unavailable" }, 502); }
	if (!tokenResponse.ok) return json({ ok: false, error: "oauth_exchange_failed" }, 502);
	let token;
	try { token = await tokenResponse.json(); } catch { return json({ ok: false, error: "oauth_exchange_invalid" }, 502); }
	if (!token?.access_token) return json({ ok: false, error: "oauth_exchange_invalid" }, 502);
	let profileResponse;
	try { profileResponse = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${token.access_token}` } }); } catch { return json({ ok: false, error: "oauth_profile_unavailable" }, 502); }
	if (!profileResponse.ok) return json({ ok: false, error: "oauth_profile_failed" }, 502);
	let profile;
	try { profile = await profileResponse.json(); } catch { return json({ ok: false, error: "oauth_profile_invalid" }, 502); }
	if (profile?.email_verified === false) return json({ ok: false, error: "google_email_unverified" }, 403);
	try {
		const user = await upsertGoogleUser(env.DB, profile);
		const workspace = await createWorkspaceForUser(env.DB, user);
		const session = await createSession(env.DB, user, workspace);
		return new Response(null, { status: 302, headers: { location: safeReturnTo(stateRow.return_to), "set-cookie": sessionCookie(session.rawSession) } });
	} catch { return json({ ok: false, error: "account_setup_failed" }, 500); }
}

export async function handleLogout(request, env) {
	const raw = cookieValue(request, SESSION_COOKIE);
	if (raw) await env.DB.prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE session_hash = ?").bind(await sha256(raw)).run();
	return new Response(null, { status: 302, headers: { location: "/setup", "set-cookie": sessionCookie("", 0) } });
}

function friendlyJobStatus(status) {
	return ({ queued: "Queued", processing: "Processing", completed: "Saved", failed: "Needs attention", dead_letter: "Needs attention" })[status] ?? "Recorded";
}

function jobTitle(resultJson) {
	try { return String(JSON.parse(resultJson || "{}").extraction?.title ?? "").slice(0, 160) || null; } catch { return null; }
}

async function dashboardData(db, session) {
	const [workspace, sheet, telegram, jobs, errors] = await Promise.all([
		db.prepare("SELECT id, name, status FROM workspaces WHERE id = ? AND status = 'active'").bind(session.workspace_id).first(),
		db.prepare("SELECT status, external_reference FROM google_connections WHERE workspace_id = ?").bind(session.workspace_id).first(),
		db.prepare("SELECT COUNT(*) AS count FROM telegram_connections WHERE workspace_id = ? AND status = 'active'").bind(session.workspace_id).first(),
		db.prepare("SELECT id, normalized_url, status, updated_at, result_json FROM jobs WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 10").bind(session.workspace_id).all(),
		db.prepare("SELECT created_at, stage, retryable FROM errors WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 10").bind(session.workspace_id).all(),
	]);
	return {
		workspace: workspace ? { id: workspace.id, name: workspace.name, status: workspace.status } : null,
		user: { displayName: session.display_name, email: session.email, role: session.role },
		connections: { google: sheet?.status === "active" && Boolean(sheet.external_reference), telegramChats: Number(telegram?.count ?? 0) },
		jobs: (jobs?.results ?? []).map((job) => ({ title: jobTitle(job.result_json) ?? "Untitled link", url: job.normalized_url, status: friendlyJobStatus(job.status), updatedAt: job.updated_at })),
		errors: (errors?.results ?? []).map((error) => ({ when: error.created_at, area: error.stage === "google_sheets" ? "Google Sheet" : error.stage === "telegram" ? "Telegram" : "Processing", status: error.retryable ? "Retrying" : "Needs attention" })),
	};
}

function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

export async function handleSetupPage(request, env) {
	if (!env?.DB) return new Response("Setup is not configured.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
	const auth = await getSession(request, env.DB);
	if (!auth) {
		const configured = oauthConfigured(env);
		return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram Link Bot setup</title><style>${styles()}</style></head><body><main class="card"><p class="eyebrow">Telegram Link Bot</p><h1>Set up your workspace</h1><p>Sign in with Google to connect your Sheet and see what remains.</p>${configured ? '<a class="button" href="/auth/google/start?return_to=%2Fsetup">Continue with Google</a>' : '<div class="notice">Google sign-in is not configured yet. An operator must add the OAuth client settings before setup can begin.</div>'}<p class="muted">Your bot data stays separated by workspace.</p></main></body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
	}
	const csrf = await rotateCsrf(env.DB, auth);
	const data = await dashboardData(env.DB, auth);
	return new Response(renderDashboard(data, csrf), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function renderDashboard(data, csrf) {
	const sheetState = data.connections.google ? "Connected" : "Not connected";
	const telegramState = data.connections.telegramChats > 0 ? `${data.connections.telegramChats} chat connected` : "Not connected";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace setup</title><style>${styles()}</style></head><body><main class="shell"><header><div><p class="eyebrow">Telegram Link Bot</p><h1>${escapeHtml(data.workspace?.name ?? "Workspace")}</h1><p class="muted">Signed in as ${escapeHtml(data.user.email || data.user.displayName || "Google user")}</p></div><a class="link" href="/auth/logout">Sign out</a></header><section class="grid"><article class="card"><h2>Setup checklist</h2><div class="check"><span class="dot done">✓</span><div><b>Google account</b><small>Connected as ${escapeHtml(data.user.email || data.user.displayName)}</small></div></div><div class="check"><span class="dot ${data.connections.google ? "done" : "todo"}">${data.connections.google ? "✓" : "2"}</span><div><b>Google Sheet</b><small>${sheetState}</small>${data.connections.google ? '<button class="text-button" data-action="disconnect">Disconnect Sheet</button>' : '<p class="next">Paste a Sheet link below to connect it.</p>'}</div></div><div class="check"><span class="dot ${data.connections.telegramChats ? "done" : "todo"}">${data.connections.telegramChats ? "✓" : "3"}</span><div><b>Telegram</b><small>${telegramState}</small><p class="next">${data.connections.telegramChats ? "Your bot can receive links." : "Generate a one-time private or group connection link below."}</p></div></div><div class="check"><span class="dot todo">4</span><div><b>Test link</b><small>Send one URL to the bot after Telegram is connected.</small></div></div></article><article class="card"><h2>Google Sheet</h2><p class="muted">Connect a Sheet by pasting its Google Sheets link. We never ask for a service-account key here.</p><form id="sheet-form"><label for="sheet">Sheet link or ID</label><input id="sheet" name="sheet" placeholder="https://docs.google.com/spreadsheets/d/..." autocomplete="off"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button" type="submit">Save Sheet</button><p id="sheet-result" class="form-result" role="status"></p></form></article><article class="card"><h2>Telegram</h2><p class="muted">Generate a short-lived link, then open it in your private chat or group. Group connections require you to be an admin and the bot to be an admin.</p>${data.connections.telegramChats ? '<p class="next">A Telegram chat is already connected to this workspace.</p>' : '<button class="button secondary" data-action="telegram-links" type="button">Generate connect links</button>'}<p id="telegram-result" class="form-result" role="status"></p></article><article class="card"><h2>Workspace</h2><form id="workspace-form"><label for="workspace-name">Workspace name</label><input id="workspace-name" name="name" value="${escapeHtml(data.workspace?.name ?? "Workspace")}" maxlength="120"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button secondary" type="submit">Save name</button><p id="workspace-result" class="form-result" role="status"></p></form></article><article class="card wide"><h2>Recent activity</h2>${data.jobs.length ? `<ul class="activity">${data.jobs.map((job) => `<li><span><b>${escapeHtml(job.title)}</b><small>${escapeHtml(job.url)}</small></span><em>${escapeHtml(job.status)}</em></li>`).join("")}</ul>` : '<p class="muted">No links have been processed yet.</p>'}${data.errors.length ? `<h3>Needs attention</h3><ul class="activity">${data.errors.map((error) => `<li><span><b>${escapeHtml(error.area)}</b><small>${escapeHtml(error.when)}</small></span><em>${escapeHtml(error.status)}</em></li>`).join("")}</ul>` : ""}</article></section></main><script>${dashboardScript(csrf)}</script></body></html>`;
}

function dashboardScript(csrf) {
	return `const post=async(url,body)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,csrf_token:'${csrf}'})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Request failed');return d};document.querySelector('#sheet-form').addEventListener('submit',async(e)=>{e.preventDefault();const out=document.querySelector('#sheet-result');try{await post('/api/setup/sheet',{spreadsheet:e.target.sheet.value});out.textContent='Sheet saved. Refreshing…';location.reload()}catch(err){out.textContent=err.message}});document.querySelector('#workspace-form').addEventListener('submit',async(e)=>{e.preventDefault();const out=document.querySelector('#workspace-result');try{await post('/api/setup/workspace',{name:e.target.name.value});out.textContent='Workspace name saved.'}catch(err){out.textContent=err.message}});document.querySelector('[data-action="disconnect"]')?.addEventListener('click',async()=>{try{await post('/api/setup/sheet/disconnect',{});location.reload()}catch(err){alert(err.message)}});document.querySelector('[data-action="telegram-links"]')?.addEventListener('click',async()=>{const out=document.querySelector('#telegram-result');try{const d=await post('/api/setup/telegram-token',{});out.textContent='Private link: '+(d.privateUrl||'not available')+' | Group link: '+(d.groupUrl||'not available')+' — expires in '+Math.round(d.expiresInSeconds/60)+' minutes.'}catch(err){out.textContent=err.message}});`;
}

function styles() { return `:root{font-family:Inter,system-ui,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0;padding:24px}.shell,.card{max-width:980px;margin:auto}.shell{display:grid;gap:18px}header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}h1{margin:.15rem 0 .4rem;font-size:clamp(1.7rem,4vw,2.4rem)}h2{margin:0 0 14px;font-size:1.15rem}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:.75rem;font-weight:700;color:#5267b7;margin:0}.muted,small{color:#647084}.card{background:white;border:1px solid #e2e8f2;border-radius:16px;padding:22px;box-shadow:0 8px 24px #1c31500d;width:100%}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.wide{grid-column:1/-1}.button,.text-button{border:0;border-radius:9px;background:#5267b7;color:white;padding:11px 16px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}.button.secondary{background:#edf0f8;color:#3f4d83}.text-button{background:none;color:#5267b7;padding:8px 0 0;font-size:.85rem}.link{color:#5267b7;font-weight:700;text-decoration:none}.check{display:flex;gap:12px;padding:13px 0;border-top:1px solid #eef1f6}.check:first-of-type{border-top:0}.check small,.check .next{display:block;margin-top:4px}.dot{width:25px;height:25px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto;font-size:.8rem;font-weight:800}.dot.done{background:#dff6e8;color:#1c7c45}.dot.todo{background:#eef1f6;color:#667085}.next{font-size:.82rem;color:#5267b7}label{display:block;font-size:.85rem;font-weight:700;margin:12px 0 6px}input{width:100%;border:1px solid #cbd5e1;border-radius:9px;padding:11px;font:inherit;margin-bottom:12px}.form-result{min-height:1.2em;color:#5267b7;font-size:.9rem}.notice{background:#fff7df;border:1px solid #f0d58b;border-radius:10px;padding:13px;margin:16px 0}.activity{list-style:none;padding:0;margin:0}.activity li{display:flex;justify-content:space-between;gap:18px;padding:12px 0;border-top:1px solid #eef1f6}.activity small{display:block;max-width:680px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.activity em{font-style:normal;font-size:.82rem;color:#5267b7;white-space:nowrap}@media(max-width:700px){body{padding:14px}.grid{grid-template-columns:1fr}.wide{grid-column:auto}header{align-items:center}.activity li{display:block}.activity em{display:block;margin-top:4px}}`; }

export async function handleSetupApi(request, env) {
	const auth = await requireSession(request, env);
	if (!auth.ok) return auth.response;
	const { session } = auth;
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/api/setup") return json({ ok: true, data: await dashboardData(env.DB, session) }, 200, { "cache-control": "no-store" });
	let body = {};
	try { if (request.method === "POST") body = await request.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
	if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "GET, POST" });
	if (!isFreshAuthentication(session)) return json({ ok: false, error: "reauthentication_required", loginUrl: "/auth/google/start?reauth=1&return_to=%2Fsetup" }, 401);
	if (!(await csrfValid(request, session, body))) return json({ ok: false, error: "csrf_invalid" }, 403);
	if (url.pathname === "/api/setup/sheet") {
		const spreadsheetId = normalizeSpreadsheetReference(body.spreadsheet);
		if (!spreadsheetId) return json({ ok: false, error: "sheet_link_invalid" }, 400);
		await env.DB.prepare("INSERT INTO google_connections (workspace_id, provider, external_reference, status) VALUES (?, 'apps_script_bridge', ?, 'active') ON CONFLICT(workspace_id) DO UPDATE SET external_reference = excluded.external_reference, status = 'active', updated_at = CURRENT_TIMESTAMP").bind(session.workspace_id, spreadsheetId).run();
		return json({ ok: true, status: "connected" });
	}
	if (url.pathname === "/api/setup/sheet/disconnect") {
		await env.DB.prepare("UPDATE google_connections SET status = 'disconnected', updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?").bind(session.workspace_id).run();
		return json({ ok: true, status: "disconnected" });
	}
	if (url.pathname === "/api/setup/telegram-token") {
		let botUsername;
		try { botUsername = await getBotUsername(env); } catch { return json({ ok: false, error: "telegram_bot_not_configured" }, 503); }
		const links = await createTelegramLinkToken(env.DB, session.workspace_id, session.user_id, botUsername, "any");
		return json({ ok: true, ...links });
	}
	if (url.pathname === "/api/setup/workspace") {
		const name = String(body.name ?? "").trim().slice(0, 120);
		if (!name) return json({ ok: false, error: "workspace_name_required" }, 400);
		await env.DB.prepare("UPDATE workspaces SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'").bind(name, session.workspace_id).run();
		return json({ ok: true, status: "saved" });
	}
	return json({ ok: false, error: "not_found" }, 404);
}

export { SESSION_COOKIE, appBaseUrl, oauthConfigured, safeReturnTo };
