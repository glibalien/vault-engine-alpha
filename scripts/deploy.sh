#!/usr/bin/env bash
# Deploy the prod checkout: pull -> npm ci (only when the install is stale) ->
# build -> smoke -> restart -> wait until the services answer -> copy the
# Obsidian plugin (when PLUGIN_DIR is set). Stops before restart if install,
# build or smoke fails, and then prints how to put the checkout back.
set -euo pipefail

PROD_ROOT="${PROD_ROOT:-}"
# The reference deployment's units; an install made by vault-installer uses
# ENGINE_SERVICE=vault-engine. An empty CURATOR_SERVICE skips Curator.
ENGINE_SERVICE="${ENGINE_SERVICE-vault-engine-new}"
CURATOR_SERVICE="${CURATOR_SERVICE-vault-curator}"
# The live ports the post-restart check waits on, and how many seconds it waits
# for each. Engine takes about 70s to start (embedder init).
ENGINE_PORT="${ENGINE_PORT:-3334}"
CURATOR_PORT="${CURATOR_PORT:-3335}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
# Optional: a directory that receives the built Obsidian plugin (main.js,
# manifest.json, styles.css) once the services answer. Unset skips the plugin.
PLUGIN_DIR="${PLUGIN_DIR:-}"
[ -n "$ENGINE_SERVICE" ] || { echo "ENGINE_SERVICE must name Engine's systemd unit." >&2; exit 2; }
case "$HEALTH_TIMEOUT" in ''|*[!0-9]*) echo "HEALTH_TIMEOUT must be a number of seconds." >&2; exit 2 ;; esac
if [ -n "$PLUGIN_DIR" ]; then
  [ -d "$PLUGIN_DIR" ] || { echo "PLUGIN_DIR is not a directory: $PLUGIN_DIR" >&2; exit 2; }
  # Resolve it now: a relative path means the caller's directory, not the checkout.
  PLUGIN_DIR="$(cd "$PLUGIN_DIR" && pwd)"
fi
SERVICES=("$ENGINE_SERVICE")
[ -z "$CURATOR_SERVICE" ] || SERVICES+=("$CURATOR_SERVICE")

DO_PULL=1
DO_INSTALL=auto   # auto | skip
DO_RESTART=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) DO_PULL=0 ;;
    --skip-install) DO_INSTALL=skip ;;
    --no-restart) DO_RESTART=0 ;;
    *) echo "unknown arg: $arg (valid: --no-pull --skip-install --no-restart)" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "${ALLOW_NON_PROD:-0}" != "1" ]; then
  if [ -z "$PROD_ROOT" ]; then
    echo "deploy.sh requires an explicit production checkout: set PROD_ROOT=/path/to/vault-suite." >&2
    echo "Set ALLOW_NON_PROD=1 to override (e.g. for testing smoke from the dev checkout)." >&2
    exit 2
  fi
  if [ "$REPO_ROOT" != "$PROD_ROOT" ]; then
    echo "deploy.sh must run from the prod checkout ($PROD_ROOT); got '$REPO_ROOT'." >&2
    echo "Set ALLOW_NON_PROD=1 to override (e.g. for testing smoke from the dev checkout)." >&2
    exit 2
  fi
fi
cd "$REPO_ROOT"

. "$REPO_ROOT/scripts/model-validation-deployment-lock.sh"
model_validation_acquire_lock "$REPO_ROOT" create deployment || exit 1

run_without_model_validation_lock() (
  exec {MODEL_VALIDATION_LOCK_FD}<&-
  "$@"
)

# A failed step leaves the services on whatever they were running, but a pull
# has already moved the checkout, and a crash restart or reboot would start the
# moved code. Say so, and give the command that puts the checkout back.
stop_before_restart() { # step
  echo "✗ $1 failed; nothing was restarted." >&2
  if [ "$before" != "$after" ]; then
    echo "  The pull moved the checkout from ${before:0:12} to ${after:0:12}; a crash restart or reboot" >&2
    echo "  would start ${after:0:12}. To put the checkout back on ${before:0:12}:" >&2
    echo "    git -C $REPO_ROOT reset --hard $before && PROD_ROOT=$REPO_ROOT $REPO_ROOT/scripts/deploy.sh --no-pull --no-restart" >&2
  fi
  exit 1
}

before="$(run_without_model_validation_lock git rev-parse HEAD)"
after="$before"
if [ "$DO_PULL" = 1 ]; then
  echo "▶ git pull --ff-only"
  run_without_model_validation_lock git pull --ff-only
fi
after="$(run_without_model_validation_lock git rev-parse HEAD)"

# npm ci runs unless node_modules records a completed install of this
# package-lock.json under this Node ABI. That covers a lockfile change, an
# install that failed or was interrupted (npm ci deletes node_modules, record
# included), and a Node major upgrade (better-sqlite3 is built per ABI).
INSTALL_RECORD="node_modules/.deploy-install"
install_reason() { # want_lock want_abi
  local have_lock have_abi
  [ -f "$INSTALL_RECORD" ] || { echo "no record of a completed install"; return; }
  have_lock="$(sed -n 's/^lock=//p' "$INSTALL_RECORD")"
  have_abi="$(sed -n 's/^abi=//p' "$INSTALL_RECORD")"
  [ "$have_lock" = "$1" ] || { echo "package-lock.json changed"; return; }
  [ "$have_abi" = "$2" ] || echo "Node ABI changed from ${have_abi:-unknown} to $2"
}
if [ "$DO_INSTALL" = skip ]; then
  echo "▶ npm ci skipped (--skip-install)"
else
  want_lock="$(sha256sum package-lock.json | cut -d' ' -f1)"
  want_abi="$(run_without_model_validation_lock node -p process.versions.modules)"
  reason="$(install_reason "$want_lock" "$want_abi")"
  if [ -n "$reason" ]; then
    echo "▶ npm ci ($reason)"
    # sharp compiles from source (and fails: no node-addon-api) whenever the host
    # has a system libvips it considers new enough; use its prebuilt binary.
    run_without_model_validation_lock env SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci || stop_before_restart "npm ci"
    mkdir -p node_modules
    printf 'lock=%s\nabi=%s\n' "$want_lock" "$want_abi" > "$INSTALL_RECORD"
  else
    echo "▶ npm ci skipped (node_modules matches package-lock.json and Node ABI $want_abi)"
  fi
fi

echo "▶ npm run build"
run_without_model_validation_lock npm run build || stop_before_restart "build"
if [ -n "$PLUGIN_DIR" ]; then
  echo "▶ npm run build -w vault-obsidian"
  run_without_model_validation_lock npm run build -w vault-obsidian || stop_before_restart "plugin build"
fi

echo "▶ smoke"
run_without_model_validation_lock env SMOKE_CURATOR="$([ -n "$CURATOR_SERVICE" ] && echo 1 || echo 0)" "$REPO_ROOT/scripts/smoke.sh" \
  || stop_before_restart "smoke"

PLUGIN_FILES=(packages/obsidian-plugin/main.js packages/obsidian-plugin/manifest.json packages/obsidian-plugin/styles.css)

if [ "$DO_RESTART" != 1 ]; then
  echo "✓ build + smoke passed. To go live, run:"
  echo "    sudo systemctl restart ${SERVICES[*]}"
  [ -z "$PLUGIN_DIR" ] || echo "    cp ${PLUGIN_FILES[*]/#/$REPO_ROOT/} $PLUGIN_DIR/"
  exit 0
fi

wait_until_answering() { # unit port
  local unit="$1" port="$2" code="" start="$SECONDS"
  while [ $((SECONDS - start)) -lt "$HEALTH_TIMEOUT" ]; do
    code="$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:$port/mcp" || true)"
    if [ "$code" = 200 ]; then
      echo "  ✓ $unit answering on :$port ($((SECONDS - start))s)"
      return 0
    fi
    sleep 1
  done
  echo "✗ $unit did not answer on :$port within ${HEALTH_TIMEOUT}s (last HTTP code '$code'). Its log since the restart:" >&2
  journalctl -u "$unit" --since "@$restart_at" --no-pager -n 30 >&2 2>/dev/null || true
  exit 1
}

if [ -n "$CURATOR_SERVICE" ]; then
  curator_stop_timeout="$(systemctl show -p TimeoutStopUSec --value "$CURATOR_SERVICE" 2>/dev/null || true)"
  echo "▶ restart (sudo): ${SERVICES[*]}"
  echo "  Curator stops only after any curation in flight finishes${curator_stop_timeout:+ (up to $curator_stop_timeout)}."
else
  echo "▶ restart (sudo): ${SERVICES[*]}"
fi
restart_at="$(date +%s)"
run_without_model_validation_lock sudo systemctl restart "${SERVICES[@]}"

wait_until_answering "$ENGINE_SERVICE" "$ENGINE_PORT"
[ -z "$CURATOR_SERVICE" ] || wait_until_answering "$CURATOR_SERVICE" "$CURATOR_PORT"

for unit in "${SERVICES[@]}"; do
  # grep reads the whole journal (no -q): with pipefail, an early exit would
  # break journalctl's pipe and turn a match into a false.
  if journalctl -u "$unit" --since "@$restart_at" --no-pager -o cat 2>/dev/null | grep "State 'stop-sigterm' timed out" >/dev/null; then
    echo "⚠ $unit did not stop within its stop timeout and was killed; any work it had in flight was cut off." >&2
  fi
done

if [ -n "$PLUGIN_DIR" ]; then
  cp "${PLUGIN_FILES[@]}" "$PLUGIN_DIR/"
  echo "  ✓ Obsidian plugin copied to $PLUGIN_DIR"
fi
echo "✓ deployed + restarted"
