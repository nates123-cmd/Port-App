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
import { writeFile, mkdir } from "node:fs/promises";

const URL = need("SUPABASE_URL");
const KEY = need("SUPABASE_SERVICE_KEY");
const OWNER = need("OWNER_ID");
const CLAUDE = process.env.CLAUDE_BIN || `${homedir()}/.local/bin/claude`;
const PERM = process.env.PERMISSION_MODE || "";
const ALLOWED = process.env.ALLOWED_TOOLS || "";
const POLL_MS = +(process.env.POLL_MS || 2000);
const MAX_TURN_MS = +(process.env.MAX_TURN_MS || 900000);
const LIVE_MS = +(process.env.LIVE_MS || 600); // min gap between live stream writes
const MAX_CONCURRENT = +(process.env.MAX_CONCURRENT || 3); // distinct sessions that can run at once
const running = new Set(); // session ids with a run in flight (this daemon)
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
function runClaudeStream({ prompt, cwd, resumeId, onLive, checkStop }) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (resumeId) args.push("--resume", resumeId);
    if (PERM) args.push("--permission-mode", PERM);
    if (ALLOWED) args.push("--allowedTools", ALLOWED);
    const child = spawn(CLAUDE, args, { cwd: cwd || homedir(), env: process.env });
    let buf = "", live = "", finalText = "", sessionId = resumeId || null;
    let isError = false, costUsd = null, numTurns = null, errText = "", rate = null;
    let stopped = false, timedOut = false;
    const killer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, MAX_TURN_MS);
    // #4: poll for a stop request from the phone (session state -> 'stop'); kill the run if asked
    const stopPoll = checkStop ? setInterval(async () => {
      try { if (await checkStop()) { stopped = true; clearInterval(stopPoll); child.kill("SIGKILL"); } } catch {}
    }, 2500) : null;

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
      if (ev.type === "rate_limit_event") {
        const i = ev.rate_limit_info; if (i) rate = { status: i.status, resetsAt: i.resetsAt, overageStatus: i.overageStatus };
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
      clearTimeout(killer); if (stopPoll) clearInterval(stopPoll);
      const base = finalText || live;
      if (stopped)  return resolve({ ok: false, stopped: true,  text: (base ? base + "\n\n" : "") + "■ Stopped.", sessionId, costUsd, numTurns, rate });
      if (timedOut) return resolve({ ok: false, timedOut: true, text: (base ? base + "\n\n" : "") + "⏱ Hit the 15-min limit — reply \"continue\" to resume.", sessionId, costUsd, numTurns, rate });
      const ok = !isError && finalText !== "";
      resolve({ ok, text: ok ? base : (base || errText || `claude exited ${code}`).slice(0, 4000), sessionId, costUsd, numTurns, rate });
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

async function pushNotify(title, body, sessionId) {
  if (!PUSH_SECRET) return;
  try {
    await fetch(`${URL}/functions/v1/port-push`, {
      method: "POST",
      headers: { authorization: `Bearer ${PUSH_SECRET}`, "content-type": "application/json" },
      // sid lets the SW deep-link to the session (#7); harmless if the edge fn doesn't forward it
      body: JSON.stringify({ title: `Port · ${title}`, body: (body || "needs your input").slice(0, 160), sid: sessionId || null }),
    });
  } catch {}
}

// #8: download an attached image from the port-uploads bucket (service key bypasses RLS) to a
// local temp file so Claude can view it with the Read tool. Returns the local path, or null.
async function downloadAttachment(path) {
  try {
    const enc = String(path).split("/").map(encodeURIComponent).join("/");
    const r = await fetch(`${URL}/storage/v1/object/port-uploads/${enc}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const dir = `${homedir()}/port/att`;
    await mkdir(dir, { recursive: true });
    const local = `${dir}/${String(path).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await writeFile(local, buf);
    return local;
  } catch { return null; }
}

async function setState(id, state, lastLine) {
  await sb(`port_sessions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { state, ...(lastLine != null ? { last_line: lastLine.slice(0, 200) } : {}), updated_at: new Date().toISOString() },
  });
}

async function processMessage(sess, msg) {
    try {
      await setState(sess.id, "working", "thinking…");

      // #8: if the user attached an image, fetch it locally and tell Claude where to Read it.
      let prompt = msg.content;
      const att = msg.card && msg.card.att;
      if (att) {
        const local = await downloadAttachment(att);
        if (local) prompt = `${prompt}\n\n[The user attached an image — view it with the Read tool at: ${local}]`;
      }

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

      const checkStop = async () => {
        try { const s = (await sb(`port_sessions?id=eq.${encodeURIComponent(sess.id)}&select=state`))?.[0]; return s?.state === "stop"; } catch { return false; }
      };
      const res = await runClaudeStream({ prompt, cwd: sess.cwd, resumeId: sess.claude_session_id, onLive, checkStop });
      done = true; clearTimeout(timer); pending = null;
      await inflight; // ensure the last streaming write lands before we finalize

      const softStop = res.stopped || res.timedOut; // not a real error — leave the session resumable
      const summary = res.ok ? await makeCard(res.text) : null;
      const meta = {};
      if (res.costUsd != null) meta.cost_usd = res.costUsd;
      if (res.numTurns != null) meta.num_turns = res.numTurns;
      if (res.rate && res.rate.status && res.rate.status !== "allowed") meta.rl = res.rate; // #5: surface only when actually limited
      const card = summary ? { ...summary, ...meta } : (Object.keys(meta).length ? meta : null);
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
        state: (res.ok || softStop) ? "waiting" : "error",
        last_line: finalContent.slice(0, 200),
        updated_at: new Date().toISOString(),
      }});
      if (res.ok && card && card.question) await pushNotify(sess.title || sess.id, card.question, sess.id); // ping when it asks a decision
      else if (res.timedOut) await pushNotify(sess.title || sess.id, "⏱ hit the time limit — reply 'continue'", sess.id); // #3: don't fail silently
    } catch (e) {
      await sb("port_messages", { method: "POST", body: { user_id: OWNER, session_id: sess.id, role: "assistant", content: `⚠️ ${String(e).slice(0, 500)}`, delivered: true }});
      await setState(sess.id, "error", String(e).slice(0, 200));
    }
}

async function tick() {
  // #2 reaper: flip abandoned 'working' sessions (daemon died mid-run) back to error so they stop
  // spinning forever and the lock releases. Threshold > hard cap so a legit long run is never
  // falsely reaped; skip sessions this daemon is actively running.
  const stuck = await sb(`port_sessions?state=eq.working&user_id=eq.${OWNER}&select=id,updated_at`);
  for (const s of stuck || []) {
    if (!running.has(s.id) && Date.now() - new Date(s.updated_at || 0).getTime() > MAX_TURN_MS + 60000)
      await setState(s.id, "error", "run abandoned (daemon restart?) — send a message to retry");
  }
  if (running.size >= MAX_CONCURRENT) return; // all run slots busy

  // Launch up to MAX_CONCURRENT distinct sessions concurrently; never two runs on one session,
  // and messages within a session stay ordered (oldest first; same-session extras wait their turn).
  const msgs = await sb(`port_messages?role=eq.user&delivered=eq.false&user_id=eq.${OWNER}&order=id.asc&limit=10`);
  for (const m of msgs || []) {
    if (running.size >= MAX_CONCURRENT) break;
    if (running.has(m.session_id)) continue; // a run for this session is already in flight
    const sess = (await sb(`port_sessions?id=eq.${encodeURIComponent(m.session_id)}&limit=1`))?.[0];
    if (!sess) { await sb(`port_messages?id=eq.${m.id}`, { method: "PATCH", body: { delivered: true } }); continue; }
    // cross-daemon / in-flight guard: skip a session whose run is genuinely active (working & fresh).
    if (sess.state === "working" && Date.now() - new Date(sess.updated_at || 0).getTime() < MAX_TURN_MS + 60000) continue;
    // Claim BEFORE running so a crash/restart can't re-spawn a duplicate --resume on this session.
    running.add(m.session_id);
    await sb(`port_messages?id=eq.${m.id}`, { method: "PATCH", body: { delivered: true } });
    processMessage(sess, m).finally(() => running.delete(m.session_id)); // concurrent: do NOT await
  }
}

console.log(`[port-server] up. claude=${CLAUDE} perm=${PERM || "(none!)"} poll=${POLL_MS}ms stream=on conc=${MAX_CONCURRENT}`);
for (;;) {
  try { await tick(); } catch (e) { console.error("[tick]", String(e).slice(0, 300)); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
