#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$REPO_ROOT/scripts/run-docs-oss-auto.sh"
MARKER="# stackbilt-docs-oss-sync"
SCHEDULE="${1:-17 9 * * *}"
ENTRY="$SCHEDULE $RUNNER $MARKER"

if ! command -v crontab >/dev/null 2>&1; then
  echo "crontab command not found"
  exit 1
fi

TMP_FILE="$(mktemp)"
crontab -l 2>/dev/null | sed "/$MARKER/d" >"$TMP_FILE" || true
echo "$ENTRY" >>"$TMP_FILE"
crontab "$TMP_FILE"
rm -f "$TMP_FILE"

echo "Installed cron entry:"
echo "  $ENTRY"
