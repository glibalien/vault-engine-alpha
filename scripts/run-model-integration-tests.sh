#!/usr/bin/env bash
# Run the explicit real-model integration lane against an isolated model cache.
# This script never pulls, installs, builds, restarts services, or touches vault data.
set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_ROOT="$REPO_ROOT/packages/engine"
WORKER_PATH="$ENGINE_ROOT/dist/search/embedder-worker.js"
PROVENANCE_PATH="$ENGINE_ROOT/dist/search/embedder-worker.build.json"

fail() {
  echo "[model-tests] ERROR: $1" >&2
  exit 1
}

TEST_MODELS_DIR="${VAULT_ENGINE_MODELS_DIR:-}"
LIVE_MODELS_DIR="${VAULT_ENGINE_LIVE_MODELS_DIR:-}"

[ -f "$REPO_ROOT/package.json" ] || fail "repository root not found: $REPO_ROOT"
[ -n "$TEST_MODELS_DIR" ] || fail "VAULT_ENGINE_MODELS_DIR is required"
[ -n "$LIVE_MODELS_DIR" ] || fail "VAULT_ENGINE_LIVE_MODELS_DIR is required to prove cache isolation"
[ -d "$TEST_MODELS_DIR/nomic-ai" ] || fail "Nomic test cache missing: $TEST_MODELS_DIR/nomic-ai"
[ -d "$LIVE_MODELS_DIR/nomic-ai" ] || fail "live Nomic cache missing: $LIVE_MODELS_DIR/nomic-ai"

TEST_MODELS_REAL="$(realpath "$TEST_MODELS_DIR")"
LIVE_MODELS_REAL="$(realpath "$LIVE_MODELS_DIR")"
TEST_NOMIC_REAL="$(realpath "$TEST_MODELS_DIR/nomic-ai")"
LIVE_NOMIC_REAL="$(realpath "$LIVE_MODELS_DIR/nomic-ai")"
[ "$TEST_MODELS_REAL" != "$LIVE_MODELS_REAL" ] || fail "test cache must differ from live cache"
[ "$TEST_NOMIC_REAL" != "$LIVE_NOMIC_REAL" ] || fail "test cache must differ from live cache"

export VAULT_ENGINE_MODELS_DIR="$TEST_MODELS_REAL"
unset VAULT_ENGINE_LIVE_MODELS_DIR
export VAULT_ENGINE_MODELS_OFFLINE=1

. "$REPO_ROOT/scripts/model-validation-deployment-lock.sh"
model_validation_acquire_lock "$REPO_ROOT" existing model-validation || exit 1

run_without_model_validation_lock() (
  exec {MODEL_VALIDATION_LOCK_FD}<&-
  "$@"
)

[ -x "$REPO_ROOT/node_modules/.bin/vitest" ] || fail "dependencies missing; deploy/install before running"
[ -f "$WORKER_PATH" ] || fail "compiled worker missing: $WORKER_PATH; deploy/build before running"
[ -f "$PROVENANCE_PATH" ] || fail "compiled worker provenance missing: $PROVENANCE_PATH; deploy/build before running"

if ! VERIFIED_ATTESTATION="$(run_without_model_validation_lock node "$REPO_ROOT/scripts/embedder-worker-provenance.mjs" verify-attestation "$REPO_ROOT")"; then
  fail 'pre-run compiled worker provenance verification failed'
fi
IFS=' ' read -r VERIFIED_COMMIT VERIFIED_FINGERPRINT <<< "$VERIFIED_ATTESTATION"
[ -n "$VERIFIED_COMMIT" ] && [ -n "$VERIFIED_FINGERPRINT" ] || fail 'pre-run compiled worker attestation output was malformed'
if ! STARTED_AT="$(run_without_model_validation_lock date --iso-8601=seconds)"; then fail 'could not collect start time metadata'; fi
if ! NODE_VERSION="$(run_without_model_validation_lock node --version)"; then fail 'could not collect Node version metadata'; fi
if ! NPM_VERSION="$(run_without_model_validation_lock npm --version)"; then fail 'could not collect npm version metadata'; fi

echo "[model-tests] started_at=$STARTED_AT"
echo "[model-tests] commit=$VERIFIED_COMMIT"
echo "[model-tests] node=$NODE_VERSION"
echo "[model-tests] npm=$NPM_VERSION"
echo "[model-tests] test_cache=$TEST_MODELS_REAL"
RESULT_FILE="$(run_without_model_validation_lock mktemp "${TMPDIR:-/tmp}/vault-engine-model-tests.XXXXXX")" || fail 'could not create private result file'
trap 'run_without_model_validation_lock rm -f -- "$RESULT_FILE"' EXIT
run_without_model_validation_lock chmod 0600 "$RESULT_FILE"

echo "[model-tests] command=npm run test:model -w vault-engine -- --no-cache --reporter=verbose --reporter=json --outputFile.json=<private-temp-file>"

cd "$REPO_ROOT"
set +e
run_without_model_validation_lock npm run test:model -w vault-engine -- --no-cache --reporter=verbose --reporter=json --outputFile.json="$RESULT_FILE"
TEST_STATUS=$?
set -e

POST_STATUS=0
POST_ATTESTATION=''
POST_ATTESTATION="$(run_without_model_validation_lock node "$REPO_ROOT/scripts/embedder-worker-provenance.mjs" verify-attestation "$REPO_ROOT")" || POST_STATUS=$?

if [ "$POST_STATUS" -eq 0 ]; then
  IFS=' ' read -r POST_COMMIT POST_FINGERPRINT <<< "$POST_ATTESTATION"
  [ -n "$POST_COMMIT" ] && [ -n "$POST_FINGERPRINT" ] || POST_STATUS=1
fi

if [ "$TEST_STATUS" -ne 0 ]; then exit "$TEST_STATUS"; fi
[ "$POST_STATUS" -eq 0 ] || fail 'compiled worker provenance changed during model validation'
[ "$VERIFIED_FINGERPRINT" = "$POST_FINGERPRINT" ] || fail 'compiled worker provenance changed during model validation'
run_without_model_validation_lock node "$REPO_ROOT/scripts/verify-model-test-result.mjs" "$RESULT_FILE"
