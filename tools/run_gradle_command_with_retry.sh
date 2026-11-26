#!/usr/bin/env bash

# Runs a Gradle-backed Flutter command and retries only transient HTTP 429
# dependency-resolution failures. Compilation errors and every other non-zero
# exit status are returned immediately.
set -uo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <command> [arguments...]" >&2
  exit 2
fi

readonly max_attempts=3
log_file="$(mktemp "${TMPDIR:-/tmp}/stayserve-gradle-retry.XXXXXX.log")"
trap 'rm -f "${log_file}"' EXIT

is_transient_dependency_429() {
  grep -Eiq '(^|[^0-9])429([^0-9]|$)' "${log_file}" &&
    grep -Eiq 'too many requests|status code 429|http 429' "${log_file}" &&
    grep -Eiq 'maven|gradle|could not (get|head|resolve|download)' "${log_file}"
}

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  echo "Gradle command attempt ${attempt}/${max_attempts}: $*"

  set +e
  "$@" 2>&1 | tee "${log_file}"
  command_status=${PIPESTATUS[0]}
  set -e

  if [[ ${command_status} -eq 0 ]]; then
    exit 0
  fi

  if ! is_transient_dependency_429; then
    exit "${command_status}"
  fi

  if [[ ${attempt} -eq ${max_attempts} ]]; then
    echo "The Gradle dependency repositories still returned HTTP 429 after ${max_attempts} attempts." >&2
    exit "${command_status}"
  fi

  delay_seconds=$((attempt * 15))
  echo "Transient Maven/Gradle HTTP 429 failure; retrying in ${delay_seconds} seconds." >&2
  sleep "${delay_seconds}"
done

exit 1
