#!/usr/bin/env bash
# Smoke-test freshly-built services: boot each in isolation on a spare port
# against throwaway state, probe it, tear it down. Exit 0 = all healthy.
# Location-agnostic: smokes the checkout this script lives in.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${VAULT_SUITE_DATA:-$HOME/vault-suite-data}"
# SMOKE_CURATOR=0 skips Curator, for an installation without it (no curator.env).
SMOKE_CURATOR="${SMOKE_CURATOR:-1}"

SMOKE_ENGINE_PORT=38334
SMOKE_CURATOR_PORT=38335

TMP="$(mktemp -d)"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] || continue
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] || continue
    kill -9 "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "✗ SMOKE FAILED: $1" >&2
  if [ -n "${2:-}" ] && [ -f "${2:-}" ]; then
    echo "--- last 30 log lines ($2) ---" >&2
    tail -n 30 "$2" >&2 || true
  fi
  exit 1
}

port_in_use() { ss -ltn 2>/dev/null | grep -q "127.0.0.1:$1 "; }

wait_for_port() { # port timeout_s logfile pid
  local port="$1" timeout="$2" logf="$3" pid="$4" i
  for ((i=0; i<timeout; i++)); do
    kill -0 "$pid" 2>/dev/null || fail "process exited during boot" "$logf"
    port_in_use "$port" && return 0
    sleep 1
  done
  fail "timed out (${timeout}s) waiting for port $port" "$logf"
}

stop_pid() { # pid
  kill "$1" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
}

# Export KEY=VALUE pairs from a systemd-style EnvironmentFile WITHOUT shell
# evaluation (values may contain spaces/globs, e.g. NORMALIZE_CRON=0 3 * * *).
load_env_file() { # path
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    [ "${line#*=}" = "$line" ] && continue   # no '=' → skip
    key="${line%%=*}"; val="${line#*=}"
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    export "$key=$val"
  done < "$1"
}

# ---- preflight: smoke ports must be free ----
for p in "$SMOKE_ENGINE_PORT" "$SMOKE_CURATOR_PORT"; do
  port_in_use "$p" && fail "smoke port $p already in use"
done

# ---- engine (isolated temp vault + temp DB) ----
echo "▶ smoke: engine"
mkdir -p "$TMP/vault"
printf '# smoke note\n\nhello world\n' > "$TMP/vault/note.md"

# Mint a throwaway service token into the temp DB before boot. POST /mcp is
# bearer-gated whenever OAUTH_OWNER_PASSWORD/OAUTH_ISSUER_URL are set (they
# always are for --transport http — see validateAuthEnv in src/index.ts), so
# the get-settings check below needs a valid token to authenticate. This is
# the same non-interactive auth pattern vault-curator uses against the live
# engine (scripts/issue-service-token.ts). createAuthSchema is idempotent
# (CREATE TABLE IF NOT EXISTS), so pre-seeding this row ahead of the engine's
# own boot-time schema creation is safe.
SMOKE_TOKEN="$(
  cd "$REPO_ROOT/packages/engine" &&
  VAULT_PATH="$TMP/vault" DB_PATH="$TMP/engine.db" \
    "$REPO_ROOT/node_modules/.bin/tsx" scripts/issue-service-token.ts --name smoke --ttl-days 1 \
    | sed -n 's/^  Authorization: Bearer //p'
)"
[ -n "$SMOKE_TOKEN" ] || fail "could not mint smoke service token"

ENGINE_LOG="$TMP/engine.log"
(
  load_env_file "$DATA_DIR/engine.env"
  # engine.env carries the real VAULT_PATH/DB_PATH which would override the
  # positional args — force them to the throwaway temp paths for isolation.
  export VAULT_PATH="$TMP/vault"
  export DB_PATH="$TMP/engine.db"
  export VAULT_BACKUP_DISABLED=1
  exec node "$REPO_ROOT/packages/engine/dist/index.js" \
    "$TMP/engine.db" "$TMP/vault" --transport http --port "$SMOKE_ENGINE_PORT"
) >"$ENGINE_LOG" 2>&1 &
ENGINE_PID=$!; PIDS+=("$ENGINE_PID")
wait_for_port "$SMOKE_ENGINE_PORT" 90 "$ENGINE_LOG" "$ENGINE_PID"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SMOKE_ENGINE_PORT/mcp" || true)"
[ "$code" = "200" ] || fail "engine GET /mcp returned '$code' (want 200)" "$ENGINE_LOG"
grep -q "HTTP listening on http://localhost:$SMOKE_ENGINE_PORT/mcp" "$ENGINE_LOG" \
  || fail "engine missing 'HTTP listening' log line" "$ENGINE_LOG"
echo "  ✓ engine boots + serves (GET /mcp → 200)"

# ---- engine settings (Phase 1): authenticated get-settings round-trip ----
# Proves the settings system (registry, store, service) boots cleanly and
# reports both domains — not just that the process is up. Requires the full
# MCP handshake (initialize → tools/call) since, unlike the GET /mcp probe
# above, POST /mcp is bearer-gated.
MCP_ACCEPT='application/json, text/event-stream'
INIT_HEADERS="$TMP/init-headers.txt"
curl -s --max-time 30 -D "$INIT_HEADERS" -o "$TMP/init-body.txt" \
  -H 'Content-Type: application/json' -H "Accept: $MCP_ACCEPT" \
  -H "Authorization: Bearer $SMOKE_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}' \
  "http://127.0.0.1:$SMOKE_ENGINE_PORT/mcp" \
  || fail "engine initialize request failed" "$ENGINE_LOG"
SESSION_ID="$(grep -i '^mcp-session-id:' "$INIT_HEADERS" | tr -d '\r' | sed -E 's/^[Mm][Cc][Pp]-[Ss]ession-[Ii]d: *//')"
[ -n "$SESSION_ID" ] || fail "engine initialize did not return mcp-session-id" "$ENGINE_LOG"

SETTINGS_BODY="$(curl -s --max-time 30 \
  -H 'Content-Type: application/json' -H "Accept: $MCP_ACCEPT" \
  -H "Authorization: Bearer $SMOKE_TOKEN" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get-settings","arguments":{}}}' \
  "http://127.0.0.1:$SMOKE_ENGINE_PORT/mcp")" \
  || fail "engine get-settings request failed" "$ENGINE_LOG"
# The response may be SSE-framed (`data: <json-rpc>`) or plain JSON depending
# on content negotiation — strip the SSE framing if present, then parse the
# JSON-RPC payload properly with node (already this script's core dependency)
# instead of grepping escaped substrings, so pretty-print or framing changes
# can't spuriously abort a good deploy. The tool envelope is itself a JSON
# string at .result.content[0].text (same shape tests/smoke.test.ts parses).
SETTINGS_JSON="$(printf '%s\n' "$SETTINGS_BODY" | sed -n 's/^data: //p' | head -n 1)" || SETTINGS_JSON=""
[ -n "$SETTINGS_JSON" ] || SETTINGS_JSON="$SETTINGS_BODY"
printf '%s' "$SETTINGS_JSON" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", () => {
    try {
      const rpc = JSON.parse(raw);
      const env = JSON.parse(rpc.result.content[0].text);
      const domains = env.ok === true && env.data ? env.data.domains : undefined;
      if (domains && domains.engine && domains.wiki && domains.chat && domains.curator
          && domains.models && Array.isArray(domains.models.catalog)) process.exit(0);
      console.error("get-settings envelope check failed: " + JSON.stringify({
        ok: env.ok,
        domains: domains ? Object.keys(domains) : null,
      }));
    } catch (err) {
      console.error("get-settings response unparseable: " + err.message);
    }
    process.exit(1);
  });
' || fail "get-settings did not return ok:true with domains{engine,wiki,chat,curator,models}" "$ENGINE_LOG"
echo "  ✓ engine settings system reachable (get-settings → ok:true, domains{engine,wiki,chat,curator,models})"

stop_pid "$ENGINE_PID"

if [ "$SMOKE_CURATOR" = 0 ]; then
  echo "▶ smoke: curator skipped (SMOKE_CURATOR=0)"
  echo "✓ ALL SMOKE CHECKS PASSED"
  exit 0
fi

# ---- curator (ENGINE_URL unreachable: prevents the boot catch-up sweep from
#      touching the live vault — see server.ts:48-61) ----
echo "▶ smoke: curator"
CURATOR_LOG="$TMP/curator.log"
(
  load_env_file "$DATA_DIR/curator.env"
  export CURATOR_PORT="$SMOKE_CURATOR_PORT"
  export CURATOR_DB_PATH="$TMP/curator.db"
  export ENGINE_URL="http://127.0.0.1:1"
  exec node "$REPO_ROOT/packages/curator/dist/server.js"
) >"$CURATOR_LOG" 2>&1 &
CURATOR_PID=$!; PIDS+=("$CURATOR_PID")
wait_for_port "$SMOKE_CURATOR_PORT" 30 "$CURATOR_LOG" "$CURATOR_PID"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SMOKE_CURATOR_PORT/mcp" || true)"
{ [ -n "$code" ] && [ "$code" != "000" ]; } \
  || fail "curator /mcp gave no HTTP response (code='$code')" "$CURATOR_LOG"
echo "  ✓ curator boots + serves (/mcp → HTTP $code)"
stop_pid "$CURATOR_PID"

echo "✓ ALL SMOKE CHECKS PASSED"
