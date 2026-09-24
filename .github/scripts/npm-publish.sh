#!/usr/bin/env bash
#
# Shared wrapper for every `npm publish` call in .github/workflows/publish.yml. Usage:
#
#   .github/scripts/npm-publish.sh <package-dir-or-tarball> [npm publish args...]
#
# This release publishes several packages from the same job run, some of them in a loop (the
# platform packages), and a release can need re-running after a partial failure — the same tag push
# re-executes every publish step, including ones that already succeeded. A bare `npm publish` isn't
# safe to call that way: re-publishing an already-live version is a hard error, not a no-op, and a
# transient registry hiccup on one package would otherwise need a human to notice, work out that it
# was transient, and retry that one publish by hand.
#
# Two things this handles, neither of which is "the publish is broken":
#
# 1. Already published at this version -> treated as success. Lets a re-run of a partially-failed
#    release skip everything that already landed and only retry what didn't, without a human sorting
#    out which is which first.
# 2. A short list of known-transient registry errors (network blips, 5xx, and the kind of auth hiccup
#    that clears on a fresh attempt) -> retried with backoff, since a fresh `npm publish` often
#    succeeds where the immediately-preceding one didn't.
#
# Anything else fails immediately and is NOT retried — this must never mask a genuine publish
# failure (bad auth, a missing Trusted Publisher entry, a broken tarball).

# No `set -e`: `out=$(...)` on a failing publish would abort before we could inspect why it failed,
# which is the entire point of this script.
set -uo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: npm-publish.sh <package-dir-or-tarball> [npm publish args...]" >&2
  exit 2
fi

target=$1
shift

max_attempts=${NPM_PUBLISH_MAX_ATTEMPTS:-4}
backoff_seconds=${NPM_PUBLISH_BACKOFF_SECONDS:-20}
attempt=1
while true; do
  out=$(npm publish "$target" "$@" 2>&1)
  rc=$?
  printf '%s\n' "$out"
  if [ "$rc" -eq 0 ]; then
    exit 0
  fi

  # Classify on `npm error` lines only — an npm notice can contain text that looks similar (e.g.
  # the provenance transparency-log notice printed on every successful publish) and must never be
  # mistaken for the error it's reporting alongside.
  errs=$(printf '%s\n' "$out" | grep -i '^npm error' || true)

  if printf '%s' "$errs" | grep -qi 'cannot publish over the previously published version'; then
    echo "npm-publish: $target is already published at this version — treating as success" >&2
    exit 0
  fi
  if printf '%s' "$errs" | grep -qi 'cannot publish over previously staged version'; then
    echo "::warning::npm-publish: $target is already STAGED upstream at this version: an earlier attempt was accepted and npm is still processing it. Not retrying — a retry can only repeat this error. A later registry-visibility check decides whether it actually became installable." >&2
    exit 0
  fi

  transient=""
  if printf '%s' "$errs" | grep -qi 'TLOG_CREATE_ENTRY_ERROR\|transparency log'; then
    transient="a transparency-log conflict"
  elif printf '%s' "$errs" | grep -qi 'Failed to generate Web Auth URLs'; then
    transient="a transient registry auth error"
  elif printf '%s' "$errs" | grep -qiE 'E(502|503|504)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up'; then
    transient="a registry/network error"
  fi
  if [ -z "$transient" ]; then
    echo "npm-publish: $target failed with a non-transient error (exit $rc) — not retrying" >&2
    exit "$rc"
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "npm-publish: $target still failing on $transient after $attempt attempts — giving up" >&2
    exit "$rc"
  fi
  echo "npm-publish: $target hit $transient (attempt $attempt/$max_attempts) — retrying in ${backoff_seconds}s" >&2
  sleep "$backoff_seconds"
  attempt=$((attempt + 1))
done
