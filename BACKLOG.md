# Port — backlog

Single source of truth for planned work. Ordered by recommended sequence.
Files: frontend = `index.html` + `sw.js` (GitHub Pages PWA); daemon = `server/port-server.mjs`
(the **running** copy is `~/port/port-server.mjs` on the Beelink — keep them identical).
Supabase project `xsmnfcmtbpeaccnyinkr`; tables `port_sessions`, `port_messages`, `port_push_subs`.

> ⚠️ Daemon changes need a restart to take effect, and **the daemon often runs the very
> session driving the conversation** — never restart it from inside a Port session (it kills
> its own child = loses the reply). Restart only when no session is mid-task. See memory
> `port-daemon-restart-reentrancy`.

---

## ✅ Done
- **#2 Stuck-`working` reaper** — daemon sweeps abandoned working sessions (age > hard cap) → error.
- **#3 Graceful turn cap** — on the 15-min kill, posts "reply 'continue' to resume" + a push, state stays resumable (not error).
- **#4 Stop button** — header Stop while running sets session state `stop`; daemon polls every 2.5s and kills the run → "■ Stopped."
- **#5 Credit/quota awareness** — daemon captures `rate_limit_event`; when actually limited, shows "⚠ rate limit · resets 4pm" under the reply.
- **#6 Voice input** — 🎤 mic in the composer dictates via Web Speech API (hidden where unsupported). Frontend-only.
- **#7 Notification deep-link** — push carries `sid`; SW opens `?s=<id>` (scope-relative); app boots straight into that session. sw v14.
  ⚠️ *Needs the `port-push` Supabase edge fn to forward the `sid` field in its web-push payload — verify/patch there if deep-link doesn't fire.*
- **#1 Per-session run lock** + claim-before-run (daemon) — one run per session, mark delivered
  up front (re-entrancy safe), reclaim abandoned `working` sessions older than the hard cap.
  *Code shipped; takes effect on the next idle daemon restart.*
- **#9 Cost-per-task** — daemon writes `cost_usd`/`num_turns` onto the finalized card; frontend
  shows "6¢ · 4 turns" under the reply. sw v13. *Cost appears on replies handled after restart.*
- Live updates — stream `claude` reply into the chat bubble as it's written (daemon stream-json
  + live row; frontend render-by-id + message UPDATE subscription + cursor). sw v12.
- Swipe-up-at-bottom to refresh the chat. sw v10.
- Auto re-subscribe + silent re-fetch on foreground/online (heals dead realtime socket). sw v11.

---

## Reliability (do first — these are observed failure modes, not hypotheticals)

### 1. Per-session run lock  ★ top priority
**Problem:** nothing stops two `claude --resume <sid>` running on the same session at once
(concurrent resume corrupts the session; happened during a mid-task daemon restart).
**Fix:** claim before run, one in-flight run per session.
- Daemon: in `tick()`, mark the user message `delivered=true` **before** spawning claude
  (currently done in `finally`, i.e. after — not crash/restart-safe). This alone fixes the
  re-spawn loop.
- Add a per-session guard: skip a message whose `session.state==='working'`, or set a
  `claimed_at` timestamp on the session and skip if already claimed & fresh. Process one
  message per session per tick.
**Subsumes the earlier "re-entrancy fix" item.**

### 2. Stuck-"working" reaper
**Problem:** if the daemon dies mid-run, the session shows `working…` forever.
**Fix:** daemon writes `updated_at` heartbeat while streaming (already does on each finalize;
add a periodic touch during long runs). Separate sweep each tick: any session `state='working'`
with `updated_at` older than ~3× MAX_TURN_MS (or a heartbeat gap > N) → flip to `error` with
last_line "run abandoned (daemon restart?)".

### 3. Graceful turn-time-limit
**Problem:** `MAX_TURN_MS` (15m) hard-`SIGKILL`s long tasks silently — bad for the
"kick off a big job, check later" gym flow.
**Fix:** on the kill path in `runClaudeStream`, return ok=false with a sentinel; in `tick()`
post an assistant message "⏱ Hit the 15-min limit — reply 'continue' to resume." instead of a
bare error. Optionally make the cap configurable per session.

---

## Features

### 4. Stop button  ★ high value
**Problem:** runs `bypassPermissions` fully autonomous with no kill switch from the phone.
**Fix:**
- Frontend: a Stop control in the chat header while `state==='working'`; sets
  `port_sessions.stop_requested=true` (or inserts a control row).
- Daemon: while streaming, poll/check the flag (e.g. between events or on a timer); if set,
  `child.kill()`, post "■ Stopped." finalize, clear the flag.

### 5. Credit / quota awareness
**Problem:** you can discover you're out of credits *at* the gym. Data is already in the stream:
`rate_limit_event.rate_limit_info` has `status`, `resetsAt`, `overageStatus` (`out_of_credits`).
**Fix:** daemon captures the last `rate_limit_event`, writes `resetsAt`/status onto the session
(or a small `port_status` row); frontend shows "low on credits · resets 4pm" banner on the list.

### 6. Voice input
Mic button on the chat composer using the Web Speech API (`webkitSpeechRecognition`),
transcribe into the textarea. Pure frontend. Most gym-native input; rare in comparable apps.

### 7. Notification deep-link
**Problem:** tapping a push opens the app to the session *list*, not the session that pinged.
**Fix:** include `session_id` in the push payload (daemon `pushNotify` → edge fn `port-push`);
`sw.js` `notificationclick` opens `/?s=<id>`; frontend reads `?s=` on boot and `openSession`s it.

### 8. Screenshot / image attach  ← ONLY REMAINING ITEM
Send an image into a session (e.g. a photo of an error). Upload to Supabase Storage, pass the
path/URL in the message; daemon includes it for claude. **Deferred:** needs a Storage bucket +
RLS policy created in Supabase (no MCP/DB access from the box) — do this from the dashboard or
Supabase CLI first, then it's a small frontend (file input + upload) + daemon (pass path) change.

### 9. Cost-per-task display  ★ quick win
Daemon already captures `total_cost_usd` + `num_turns` in `runClaudeStream` (currently unused).
Write them onto the finalized message (or its card) and show "4¢ · 6 turns" under the reply.
Almost free — just plumb the two fields through finalize + render.

---

## Notes / ideas parked (lower priority)
- Permission/approval surfacing (an "ask mode" where risky actions prompt on the phone) — big.
- Plan-mode toggle per session; raw tool-call/terminal view behind the friendly card.
