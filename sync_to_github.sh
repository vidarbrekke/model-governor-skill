#!/bin/bash
set -e
cd /Users/vidarbrekke/Dev/repositories/dev/router-governor
OUT="/Users/vidarbrekke/Dev/repositories/dev/router-governor/sync_log.txt"
echo "=== git status ===" > "$OUT"
git status >> "$OUT" 2>&1
echo "=== git log -2 ===" >> "$OUT"
git log -2 --oneline >> "$OUT" 2>&1
git add -A
echo "=== after git add -A, diff --cached --stat ===" >> "$OUT"
git diff --cached --stat >> "$OUT" 2>&1
if git diff --cached --quiet 2>/dev/null; then
  echo "No changes to commit" >> "$OUT"
else
  git -c user.name="Cursor" -c user.email="cursor@local" commit -m "Single folder: router-governor as repo root, dev vs install clarified" >> "$OUT" 2>&1
  echo "Commit done" >> "$OUT"
fi
echo "=== push ===" >> "$OUT"
git push origin main >> "$OUT" 2>&1
echo "Done" >> "$OUT"
