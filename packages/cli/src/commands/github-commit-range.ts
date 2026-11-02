/** Resolve an entire GitHub event's commits, never the synthetic PR merge. */
export const GITHUB_COMMIT_RANGE_SCRIPT = `set -e
if [[ ! "$HEAD_SHA" =~ ^([[:xdigit:]]{40}|[[:xdigit:]]{64})$ ]] || [[ "$HEAD_SHA" =~ ^0+$ ]]; then
  echo '::error::No valid event head SHA; refusing to validate a guessed commit range.'
  exit 1
fi
HEAD_COMMIT=$(git rev-parse --verify "$HEAD_SHA^{commit}") || {
  echo '::error::Event head commit is unavailable. Fetch the complete event history.'
  exit 1
}
if [ -z "$BASE_SHA" ] || [[ "$BASE_SHA" =~ ^0+$ ]]; then
  # Initial pushes and manual runs have no event base: check all reachable commits.
  RANGE="$HEAD_COMMIT"
else
  if [[ ! "$BASE_SHA" =~ ^([[:xdigit:]]{40}|[[:xdigit:]]{64})$ ]]; then
    echo '::error::Invalid event base SHA; refusing to validate a guessed commit range.'
    exit 1
  fi
  BASE_COMMIT=$(git rev-parse --verify "$BASE_SHA^{commit}") || {
    echo '::error::Event base commit is unavailable. Fetch the complete event history.'
    exit 1
  }
  RANGE="$BASE_COMMIT..$HEAD_COMMIT"
fi
echo "CHARTER_COMMIT_RANGE=$RANGE" >> "$GITHUB_ENV"`;
