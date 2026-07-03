#!/usr/bin/env node
// Scan ~/.claude/skills/*/SKILL.md and emit ../skills.json for the Port palette.
// Personal (file-based) skills are auto-discovered; harness built-ins are static
// (they're not on disk). Curated short descriptions win for known skills; new
// skills get a best-effort description derived from their SKILL.md frontmatter.
// Output is sorted by name so unchanged skills produce byte-identical files
// (no spurious commits). Run via publish-skills.sh from cron.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SKILLS_DIR = join(homedir(), ".claude", "skills");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "skills.json");

// Curated short descriptions for known personal skills (nicer than auto-derived).
const CURATED = {
  amanda:"Amanda gift app", break:"5-Minute Break app", course:"Course project cockpit",
  "course-plus":"Course+ workspace", crate:"DJ set-building app", cue:"Recommendation library + media log",
  ink:"Reflective journaling PWA", patch:"Suite bug/feature/idea capture inbox",
  scribe:"Notes / reference / deliverable PWA", stock:"Recipe / pantry PWA", tick:"Habit tracker",
  tide:"Mindful-drinking + intake tracker", today:"Morning-ritual PWA", suite:"Personal OS app-suite index",
  beelink:"Manage the Beelink home server", "beelink-port":"Port a project to the Beelink & back",
  gym:"Hand this session to your phone", port:"Drive the current Mac work from Port",
  jellyfin:"Media server / *arr stack ops", "torrent-stack":"Download-pipeline health snapshot",
  openclaw:"Manage the Telegram bot", murmur:"macOS dictation app", remarkable:"reMarkable 2 tooling",
  recap:"Simplest status + the one next action", ship:"Ship the current app update",
  "patch-triage":"Triage the Patch inbox", "nate-voice":"Write / rewrite in Nate's voice",
  tutor:"Rigorous tutor to real mastery",
};

// Harness/plugin skills — not file-based, so listed statically.
const BUILTINS = [
  {n:"deep-research",d:"Fan-out, fact-checked research report"},
  {n:"code-review",d:"Review the current diff for bugs"},
  {n:"simplify",d:"Clean up the changed code"},
  {n:"verify",d:"Run the app to verify a change"},
  {n:"run",d:"Launch this project's app"},
  {n:"loop",d:"Run a command on a recurring interval"},
  {n:"schedule",d:"Manage scheduled cloud agents"},
  {n:"update-config",d:"Configure hooks / permissions"},
  {n:"fewer-permission-prompts",d:"Reduce permission prompts"},
  {n:"keybindings-help",d:"Customize keybindings"},
  {n:"claude-api",d:"Claude API / SDK reference"},
  {n:"init",d:"Initialize a CLAUDE.md"},
  {n:"review",d:"Review a pull request"},
  {n:"security-review",d:"Security review of the branch"},
];

function frontmatter(content) {
  const parts = content.split(/^---\s*$/m);
  return parts.length >= 3 ? parts[1] : "";
}
function field(front, key) {
  const m = front.match(new RegExp("^" + key + ":\\s*(.+)$", "m"));
  return m ? m[1].trim() : "";
}
// Best-effort short description for a newly-added skill without a curated entry.
function derive(raw, name) {
  let d = raw.replace(/\s+/g, " ").trim();
  d = d.replace(new RegExp("^/?" + name + "\\s*[—\\-:]\\s*", "i"), "");
  const m = d.match(/^(.*?)(?:\.\s|\s\(|$)/);
  let s = (m ? m[1] : d).trim();
  if (s.length > 70) s = s.slice(0, 67).trim() + "…";
  return s || name;
}

const found = new Map();
for (const b of BUILTINS) found.set(b.n, b.d);

if (existsSync(SKILLS_DIR)) {
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const front = frontmatter(readFileSync(file, "utf8"));
    const name = field(front, "name") || entry.name;
    const desc = CURATED[name] || derive(field(front, "description"), name);
    found.set(name, desc);
  }
}

const list = [...found.entries()]
  .map(([n, d]) => ({ n, d }))
  .sort((a, b) => a.n.localeCompare(b.n));

writeFileSync(OUT, JSON.stringify(list, null, 0) + "\n");
console.error(`gen-skills: wrote ${list.length} skills -> ${OUT}`);
