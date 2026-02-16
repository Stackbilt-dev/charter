#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: scripts/smart-commit.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo 'Error: must run inside a git repository.' >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [[ "$(git diff --name-only --cached | wc -l | tr -d ' ')" != "0" ]]; then
  echo 'Error: staged changes detected.' >&2
  echo 'Run this workflow from a clean index (unstaged/untracked changes only).' >&2
  exit 1
fi

git config core.hooksPath .githooks

if [[ ! -f ".githooks/pre-commit" ]]; then
  echo 'Error: .githooks/pre-commit is missing.' >&2
  exit 1
fi

chmod +x .githooks/pre-commit 2>/dev/null || true

mapfile -t TRACKED_FILES < <(git diff --name-only)
mapfile -t UNTRACKED_FILES < <(git ls-files --others --exclude-standard)
mapfile -t DELETED_FILES < <(git diff --name-only --diff-filter=D)

declare -A IS_DELETED=()
for file in "${DELETED_FILES[@]}"; do
  IS_DELETED["$file"]=1
done

declare -A CANDIDATE=()
for file in "${TRACKED_FILES[@]}" "${UNTRACKED_FILES[@]}"; do
  [[ -n "$file" ]] && CANDIDATE["$file"]=1
done

if [[ "${#CANDIDATE[@]}" -eq 0 ]]; then
  echo 'No unstaged or untracked changes found.'
  exit 0
fi

is_substantive_change() {
  local file="$1"

  if [[ -n "${IS_DELETED[$file]:-}" ]]; then
    return 0
  fi

  if git ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
    git diff -w --quiet -- "$file"
    [[ "$?" -ne 0 ]]
    return
  fi

  if [[ ! -f "$file" ]]; then
    return 1
  fi

  grep -q '[^[:space:]]' "$file"
}

group_for_file() {
  local file="$1"

  if [[ "$file" =~ ^packages/([^/]+)/ ]]; then
    echo "pkg:${BASH_REMATCH[1]}"
    return
  fi

  if [[ "$file" =~ ^\.github/workflows/ ]]; then
    echo 'ci:workflows'
    return
  fi

  if [[ "$file" =~ ^\.github/ ]]; then
    echo 'docs:github'
    return
  fi

  if [[ "$file" =~ ^scripts/ ]] || [[ "$file" =~ ^\.githooks/ ]]; then
    echo 'chore:scripts'
    return
  fi

  if [[ "$file" =~ ^\.(gitattributes|gitignore|mcp\.json)$ ]] || [[ "$file" == "pnpm-lock.yaml" ]] || [[ "$file" == "pnpm-workspace.yaml" ]] || [[ "$file" == "package.json" ]] || [[ "$file" == "tsconfig.base.json" ]] || [[ "$file" == "tsconfig.json" ]]; then
    echo 'chore:repo'
    return
  fi

  if [[ "$file" =~ \.md$ ]]; then
    echo 'docs:repo'
    return
  fi

  echo 'chore:misc'
}

commit_message_for_group() {
  local group="$1"

  case "$group" in
    pkg:*)
      local scope="${group#pkg:}"
      echo "feat(${scope}): apply logical updates"
      ;;
    ci:workflows)
      echo 'ci(workflows): update governance automation'
      ;;
    docs:github)
      echo 'docs(github): refresh templates and metadata'
      ;;
    docs:repo)
      echo 'docs(repo): update project documentation'
      ;;
    chore:scripts)
      echo 'chore(scripts): update commit automation workflow'
      ;;
    chore:repo)
      echo 'chore(repo): update repository configuration'
      ;;
    *)
      echo 'chore(misc): apply maintenance updates'
      ;;
  esac
}

declare -A GROUP_FILES=()
declare -A SEEN_GROUP=()
GROUP_ORDER=()
IGNORED_FILES=()

while IFS= read -r file; do
  if is_substantive_change "$file"; then
    group="$(group_for_file "$file")"
    GROUP_FILES["$group"]+="$file"$'\n'
    if [[ -z "${SEEN_GROUP[$group]:-}" ]]; then
      SEEN_GROUP["$group"]=1
      GROUP_ORDER+=("$group")
    fi
  else
    IGNORED_FILES+=("$file")
  fi
done < <(printf '%s\n' "${!CANDIDATE[@]}" | sort)

if [[ "${#GROUP_ORDER[@]}" -eq 0 ]]; then
  echo 'Only whitespace/EOL-only changes detected. No commits created.'
  exit 0
fi

if [[ "${#IGNORED_FILES[@]}" -gt 0 ]]; then
  echo 'Ignoring whitespace-only changes in:'
  for file in "${IGNORED_FILES[@]}"; do
    echo "  - $file"
  done
fi

for group in "${GROUP_ORDER[@]}"; do
  msg="$(commit_message_for_group "$group")"
  mapfile -t files < <(printf '%s' "${GROUP_FILES[$group]}" | sed '/^$/d')

  if [[ "${#files[@]}" -eq 0 ]]; then
    continue
  fi

  git add -A -- "${files[@]}"

  if git diff --cached --quiet; then
    git reset -q -- "${files[@]}"
    continue
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo
    echo "[DRY-RUN] Commit: $msg"
    for file in "${files[@]}"; do
      echo "  - $file"
    done
    git reset -q -- "${files[@]}"
  else
    echo
    echo "Creating commit: $msg"
    git commit -m "$msg"
  fi
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo 'Dry-run complete. No commits were created.'
else
  echo
  echo 'Commit workflow complete.'
fi
