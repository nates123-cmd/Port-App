#!/usr/bin/env bash
# Regenerate skills.json and, if it changed, commit + push (= GitHub Pages deploy,
# which is the only channel the phone can reach same-origin). Safe to run on a cron;
# a no-op run makes no commit. Skips entirely if the repo has other uncommitted work,
# so it never sweeps up an in-progress edit.
set -euo pipefail
REPO="/home/nate/code/Port-App"
cd "$REPO"

node server/gen-skills.mjs

# Only skills.json may be dirty — bail if anything else is uncommitted (don't co-mingle).
other="$(git status --porcelain | grep -v ' skills.json$' || true)"
if [ -n "$other" ]; then
  echo "publish-skills: repo has other uncommitted changes, skipping push"
  exit 0
fi

if git diff --quiet -- skills.json; then
  echo "publish-skills: no change"
  exit 0
fi

git add skills.json
git commit -q -m "chore: refresh skills.json (auto)"
git push -q origin main
echo "publish-skills: published"
