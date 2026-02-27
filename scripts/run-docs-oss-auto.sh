#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_ROOT/logs"
LOG_FILE="$LOG_DIR/docs-oss-auto.log"

mkdir -p "$LOG_DIR"

cd "$REPO_ROOT"
pnpm run docs:oss:auto >>"$LOG_FILE" 2>&1
