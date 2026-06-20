#!/usr/bin/env node
/**
 * Port server — drives Claude Code on the Beelink from Supabase.
 * Dependency-free (Node 18+ fetch + child_process).
 *
 * Loop: poll port_messages for undelivered user messages -> run headless
 * `claude -p <msg> --resume <sid> --output-format stream-json` in the session's
 * cwd -> stream the reply into a live assistant row (the PWA watches UPDATEs and
 * fills the bubble as text arrives) -> finalize with clean text + card. No
 * inbound ports; only outbound HTTPS to Supabase. The PWA reads/writes Supabase.
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
const LIVE_MS = +(process.env.LIVE_MS || 600); // min gap between live stream writes
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PUSH_SECRET = process.env.PORT_PUSH_SECRET || "";

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

// Run claude in streaming mode. onLive(text) fires as the reply grows (already
// throttled by the caller is unnecessary — we just emit; caller decides cadence).
function runClaudeStream({ prompt, cwd, resumeId, onLive }) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (resumeId) args.push("--resume", resumeId);
    if (PERM) args.push("--permission-mode", PERM);
    if (ALLOWED) args.push("--allowedTools", ALLOWED);
    const child = spawn(CLAUDE, args, { cwd: cwd || homedir(), env: process.env });
    let buf = "", live = "", finalText = "", sessionId = resumeId || null;
    let isError = false, costUsd = null, numTurns = null, errText = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), MAX_TURN_MS);

    function feed(ev) {
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === "stream_event") {
        const e = ev.event;
        if (e?.type === "content_block_start") {
          const cb = e.content_block;
          if (cb?.type === "tool_use") { live += `${live && !live.endsWith("\n") ? "\n" : ""}🔧 ${cb.name || "tool"}…\n`; onLive(live); }
          else if (cb?.type === "text" && live && !live.endsWith("\n")) { live += "\n"; }
        } else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
          live += e.delta.text; onLive(live);
        }
        return;
      }
      if (ev.type === "result") {
        if (typeof ev.result === "string" && ev.result) finalText = ev.result;
        costUsd = ev.total_cost_usd ?? costUsd;
        numTurns = ev.num_turns ?? numTurns;
        isError = !!ev.is_error;
      }
    }

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        try { feed(ev); } catch { /* ignore one bad event */ }
      }
    });
    child.stderr.on("data", (d) => (errText += d.toString()));
    child.on("close", (code) => {
      clearTimeout(killer);
      const text = finalText || live;
      const ok = !isError && finalText !== "";
      resolve({
        ok,
        text: ok ? text : (text || errText || `claude exited ${code}`).slice(0, 4000),
        sessionId, costUsd, numTurns,
      });
    });
  });
}

async function makeCard(raw) {
  if (!GEMINI_KEY || !raw || raw.length < 40) return null;
  const prompt = `You turn a coding assistant's reply into a simple phone card. Reply ONLY JSON.\ntldr: 1-2 plain, non-technical sentences capturing what it said / what is going on.\nquestion: if it is asking the user to decide something, the single decision as a short question; else null.\noptions: 2-4 short tappable answers (<=6 words each) if there is a clear choice; else [].\nAssistant reply:\n"""${raw.slice(0,6000)}"""`;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: {
          type: "object",
          properties: { tldr: { type: "string" }, question: { type: "string", nullable: true }, options: { type: "array", items: { type: "string" } } },
          required: ["tldr"] } },
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) return null;
    const c = JSON.parse(txt);
    return { tldr: c.tldr || "", question: c.question || null, options: Array.isArray(c.options) ? c.options.slice(0,5) : [] };
  } catch { return null; }
}

async function pushNotify(title, body) {
  if (!PUSH_SECRET) return;
  try {
    await fetch(`${URL}/functions/v1/port-push`, {
      method: "POST",
      headers: { authorization: `Bearer ${PUSH_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ title: `Port · ${title}`, body: (body || "needs your input").slice(0, 160) }),
    });
  } catch {}
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

      // Create the live assistant row the PWA fills in as text streams (card.streaming = placeholder).
      const ins = await sb("port_messages", {
        method: "POST",
        prefer: "return=representation",
        body: { user_id: OWNER, session_id: sess.id, role: "assistant", content: "", card: { streaming: true }, delivered: true },
      });
      const liveId = ins?.[0]?.id || null;

      // Throttled live writer: at most one PATCH per LIVE_MS, one in flight, trailing edge guaranteed.
      let pending = null, inflight = Promise.resolve(), timer = null, last = 0, done = false;
      const flushNow = () => {
        if (!liveId || pending === null) return;
        const t = pending; pending = null; last = Date.now();
        inflight = sb(`port_messages?id=eq.${liveId}`, { method: "PATCH", body: { content: t.slice(0, 12000), card: { streaming: true } } }).catch(() => {});
      };
      const onLive = (t) => {
        if (done || !liveId) return;
        pending = t;
        if (Date.now() - last >= LIVE_MS) flushNow();
        else { clearTimeout(timer); timer = setTimeout(flushNow, LIVE_MS); }
      };

      const res = await runClaudeStream({ prompt: m.content, cwd: sess.cwd, resumeId: sess.claude_session_id, onLive });
      done = true; clearTimeout(timer); pending = null;
      await inflight; // ensure the last streaming write lands before we finalize

      const card = res.ok ? await makeCard(res.text) : null;
      const finalContent = res.text || (res.ok ? "(no output)" : "error");
      if (liveId) {
        await sb(`port_messages?id=eq.${liveId}`, { method: "PATCH", body: { content: finalContent, card } });
      } else {
        await sb("port_messages", { method: "POST", body: {
          user_id: OWNER, session_id: sess.id, role: "assistant", content: finalContent, card, delivered: true,
        }});
      }
      await sb(`port_sessions?id=eq.${encodeURIComponent(sess.id)}`, { method: "PATCH", body: {
        claude_session_id: res.sessionId || sess.claude_session_id,
        state: res.ok ? "waiting" : "error",
        last_line: finalContent.slice(0, 200),
        updated_at: new Date().toISOString(),
      }});
      if (card && card.question) await pushNotify(sess.title || sess.id, card.question); // ping only when it asks a decision
    } catch (e) {
      await sb("port_messages", { method: "POST", body: { user_id: OWNER, session_id: sess.id, role: "assistant", content: `⚠️ ${String(e).slice(0, 500)}`, delivered: true }});
      await setState(sess.id, "error", String(e).slice(0, 200));
    } finally {
      await sb(`port_messages?id=eq.${m.id}`, { method: "PATCH", body: { delivered: true } });
    }
  }
}

console.log(`[port-server] up. claude=${CLAUDE} perm=${PERM || "(none!)"} poll=${POLL_MS}ms stream=on`);
for (;;) {
  try { await tick(); } catch (e) { console.error("[tick]", String(e).slice(0, 300)); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
