#!/usr/bin/env node
/**
 * Port server — drives Claude Code on the Beelink from Supabase.
 * Dependency-free (Node 18+ fetch + child_process).
 *
 * Loop: poll port_messages for undelivered user messages -> run headless
 * `claude -p <msg> --resume <sid> --output-format json` in the session's cwd ->
 * write the assistant reply back + update session state. No inbound ports; only
 * outbound HTTPS to Supabase. The PWA reads/writes Supabase directly.
 *
 * Env (see port-server.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY   (service_role; this is a trusted server)
 *   OWNER_ID                              (Nate's uuid; sessions scoped to this)
 *   CLAUDE_BIN        default ~/.local/bin/claude
 *   PERMISSION_MODE   e.g. acceptEdits | bypassPermissions  (REQUIRED for headless)
 *   ALLOWED_TOOLS     optional comma list passed to --allowedTools
 *   POLL_MS           default 2000
 *   MAX_TURN_MS       default 900000 (15m hard cap per message)
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const URL = need("SUPABASE_URL");
const KEY = need("SUPABASE_SERVICE_KEY");
const OWNER = need("OWNER_ID");
const CLAUDE = process.env.CLAUDE_BIN || `${homedir()}/.local/bin/claude`;
const PERM = process.env.PERMISSION_MODE || "";
const ALLOWED = process.env.ALLOWED_TOOLS || "";
const POLL_MS = +(process.env.POLL_MS || 2000);
const MAX_TURN_MS = +(process.env.MAX_TURN_MS || 900000);

function need(k) { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(1); } return v; }

async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`sb ${method} ${path} -> ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function runClaude({ prompt, cwd, resumeId }) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "json"];
    if (resumeId) args.push("--resume", resumeId);
    if (PERM) args.push("--permission-mode", PERM);
    if (ALLOWED) args.push("--allowedTools", ALLOWED);
    const child = spawn(CLAUDE, args, { cwd: cwd || homedir(), env: process.env });
    let out = "", err = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), MAX_TURN_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(killer);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* not json */ }
      if (parsed && !parsed.is_error) {
        resolve({ ok: true, text: parsed.result ?? "", sessionId: parsed.session_id ?? resumeId ?? null });
      } else {
        resolve({ ok: false, text: (parsed?.result || err || out || `claude exited ${code}`).slice(0, 4000), sessionId: resumeId ?? null });
      }
    });
  });
}

async function setState(id, state, lastLine) {
  await sb(`port_sessions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { state, ...(lastLine != null ? { last_line: lastLine.slice(0, 200) } : {}), updated_at: new Date().toISOString() },
  });
}

async function tick() {
  // oldest undelivered user messages, owner-scoped
  const msgs = await sb(`port_messages?role=eq.user&delivered=eq.false&user_id=eq.${OWNER}&order=id.asc&limit=5`);
  for (const m of msgs || []) {
    const sess = (await sb(`port_sessions?id=eq.${encodeURIComponent(m.session_id)}&limit=1`))?.[0];
    if (!sess) { await sb(`port_messages?id=eq.${m.id}`, { method: "PATCH", body: { delivered: true } }); continue; }
    try {
      await setState(sess.id, "working", "thinking…");
      const res = await runClaude({ prompt: m.content, cwd: sess.cwd, resumeId: sess.claude_session_id });
      await sb("port_messages", { method: "POST", body: {
        user_id: OWNER, session_id: sess.id, role: "assistant",
        content: res.text || (res.ok ? "(no output)" : "error"), delivered: true,
      }});
      await sb(`port_sessions?id=eq.${encodeURIComponent(sess.id)}`, { method: "PATCH", body: {
        claude_session_id: res.sessionId || sess.claude_session_id,
        state: res.ok ? "waiting" : "error",
        last_line: (res.text || "").slice(0, 200),
        updated_at: new Date().toISOString(),
      }});
    } catch (e) {
      await sb("port_messages", { method: "POST", body: { user_id: OWNER, session_id: sess.id, role: "assistant", content: `⚠️ ${String(e).slice(0, 500)}`, delivered: true }});
      await setState(sess.id, "error", String(e).slice(0, 200));
    } finally {
      await sb(`port_messages?id=eq.${m.id}`, { method: "PATCH", body: { delivered: true } });
    }
  }
}

console.log(`[port-server] up. claude=${CLAUDE} perm=${PERM || "(none!)"} poll=${POLL_MS}ms`);
for (;;) {
  try { await tick(); } catch (e) { console.error("[tick]", String(e).slice(0, 300)); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
