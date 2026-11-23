#!/usr/bin/env bash
#
# cutover.sh — vault-suite monorepo cutover for the target host (Phase 5).
#
# Repoints the two production systemd services at the consolidated monorepo
# checkout (engine -> packages/engine, curator -> packages/curator) WITHOUT
# changing ports, so the Cloudflare tunnel config in /etc/cloudflared/ is
# untouched.
#
# It is SELF-DISCOVERING: it reads each unit's current WorkingDirectory /
# ExecStart / EnvironmentFile from `systemctl cat` and derives the new paths,
# so it adapts to the real on-box definitions instead of hard-coded guesses.
#
# SAFETY:
#   - Dry-run by default. Nothing changes until you pass `apply`.
#   - Per-service and reversible: each cutover is a systemd DROP-IN
#     (/etc/systemd/system/<unit>.d/zz-monorepo-cutover.conf). `rollback`
#     deletes the drop-in and restarts on the old paths.
#   - Stops a service before copying its live SQLite .state (avoids a torn copy)
#     and never deletes the old checkout — that stays as the rollback path.
#
# USAGE (run on the target host, as the deploy user):
#   ./scripts/cutover.sh preflight              # pull main, npm ci, npm run build
#   ./scripts/cutover.sh plan                   # show what every service would change to
#   ./scripts/cutover.sh apply curator          # cut over one service (curator -> engine)
#   ./scripts/cutover.sh apply engine
#   ./scripts/cutover.sh smoke all              # health-check both services
#   ./scripts/cutover.sh rollback engine        # revert one service to the old paths
#
# Override defaults via env, e.g.  MONOREPO=/srv/vault-engine ./scripts/cutover.sh plan
#
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/model-validation-deployment-lock.sh"

# ----- config (override via environment) -----
MONOREPO="${MONOREPO:-}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
ASSUME_YES="${ASSUME_YES:-0}"   # set to 1 to skip confirmation prompts

# service registry: "key|unit|package|port|db_env_var|db_relpath"
# db_env_var/db_relpath empty => no checkout-local state to migrate (engine).
SERVICES=(
  "curator|vault-curator.service|curator|3335|CURATOR_DB_PATH|.state/curator.db"
  "engine|vault-engine-new.service|engine|3334||"
)

# ----- tiny ui helpers -----
c_bold=$'\033[1m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_rst=$'\033[0m'
say()  { printf '%s\n' "$*"; }
info() { printf '%s==>%s %s\n' "$c_bold" "$c_rst" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_grn" "$c_rst" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_yel" "$c_rst" "$*"; }
die()  { printf '%sFAIL%s %s\n' "$c_red" "$c_rst" "$*" >&2; exit 1; }
confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf '%s? %s [y/N] ' "$c_yel" "$c_rst$*"; read -r reply </dev/tty || true
  [ "${reply:-}" = "y" ] || [ "${reply:-}" = "Y" ]
}

svc_field() { # svc_field <key> <index 1-6>
  local key="$1" idx="$2" row
  for row in "${SERVICES[@]}"; do
    [ "${row%%|*}" = "$key" ] || continue
    printf '%s' "$row" | cut -d'|' -f"$idx"; return 0
  done
  die "unknown service '$key' (known: curator engine)"
}

unit_directive() { # unit_directive <unit> <Key>  -> last value of Key= in the effective unit
  systemctl cat "$1" 2>/dev/null | grep -E "^$2=" | tail -1 | cut -d'=' -f2-
}

require_box() { # only proceed where the units actually exist
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found — run this on the target host."
  [ -n "$MONOREPO" ] || die "MONOREPO is required: set MONOREPO=/path/to/monorepo-checkout."
  [ "${MONOREPO#/}" != "$MONOREPO" ] || die "MONOREPO must be an absolute path."
  MONOREPO="$(cd "$MONOREPO" 2>/dev/null && pwd -P)" || die "monorepo checkout not found at $MONOREPO (set MONOREPO=...)."
  [ -e "$MONOREPO/.git" ] || die "monorepo checkout not found at $MONOREPO (set MONOREPO=...)."
}

run_without_model_validation_lock() (
  exec {MODEL_VALIDATION_LOCK_FD}<&-
  "$@"
)

# ----- preflight: bring the monorepo checkout up to date and build -----
cmd_preflight() {
  require_box
  model_validation_acquire_lock "$MONOREPO" create cutover-preflight || die "cutover preflight cannot acquire the deployment/model-validation lock"
  info "Preflight in $MONOREPO"
  local nodev; nodev="$(run_without_model_validation_lock "$NODE_BIN" -v 2>/dev/null || echo none)"
  say "  node: $nodev  (need >= v20; native deps rebuild on npm ci)"
  case "$nodev" in v1[0-9].*|none) warn "node looks old/missing — verify before continuing." ;; esac

  ( cd "$MONOREPO"
    # Must already be ON main. We do NOT auto-switch branches: a surprise
    # `git checkout main` would orphan whatever you're on (and this script lives
    # on main — switching away would make it vanish mid-run).
    local branch; branch="$(run_without_model_validation_lock git rev-parse --abbrev-ref HEAD)"
    [ "$branch" = "main" ] || die "you are on branch '$branch', not main.
The monorepo + this script live on main. Bring the checkout there first:
  git -C $MONOREPO fetch && git -C $MONOREPO checkout main && git -C $MONOREPO pull --ff-only
then re-run: ./scripts/cutover.sh preflight"
    [ -z "$(run_without_model_validation_lock git status --porcelain)" ] || die "checkout is dirty — commit/stash on the box first:
$(run_without_model_validation_lock git -C "$MONOREPO" status --short)"
    info "git fetch + fast-forward main"
    run_without_model_validation_lock git fetch --quiet origin
    run_without_model_validation_lock git pull --ff-only origin main
    say "  HEAD: $(run_without_model_validation_lock git log --oneline -1)"
    [ -d "$MONOREPO/packages/engine" ] || die "after pull there is no packages/engine — is main the monorepo?"
    info "npm ci (single root lockfile; rebuilds native deps for this node)"
    run_without_model_validation_lock npm ci
    info "npm run build (contract -> engine -> curator)"
    run_without_model_validation_lock npm run build
  )
  ok "Preflight complete. Built dist/ exists under each packages/*."
  say "Next: ${c_bold}./scripts/cutover.sh plan${c_rst}"
}

# ----- derive the post-cutover paths for one service (prints, computes globals) -----
# sets: OLD_WD OLD_ENV OLD_EXEC NEW_WD NEW_ENV NEW_EXEC DB_ABS(0/1) STATE_SRC STATE_DST
derive() {
  local key="$1"
  local unit pkg db_env db_rel
  unit="$(svc_field "$key" 2)"; pkg="$(svc_field "$key" 3)"
  db_env="$(svc_field "$key" 5)"; db_rel="$(svc_field "$key" 6)"

  systemctl cat "$unit" >/dev/null 2>&1 || die "unit '$unit' not found on this box."
  OLD_WD="$(unit_directive "$unit" WorkingDirectory)"
  OLD_ENV="$(unit_directive "$unit" EnvironmentFile)"; OLD_ENV="${OLD_ENV#-}"   # strip leading '-'
  OLD_EXEC="$(unit_directive "$unit" ExecStart)"
  [ -n "$OLD_WD" ]   || die "$unit has no WorkingDirectory= — handle this unit by hand."
  [ -n "$OLD_EXEC" ] || die "$unit has no ExecStart= — handle this unit by hand."

  NEW_WD="$MONOREPO/packages/$pkg"
  NEW_ENV="$NEW_WD/.env"
  # Swap an absolute "<old_wd>/dist" binary path; a relative "dist/..." ExecStart
  # is left as-is and re-homed by the new WorkingDirectory.
  NEW_EXEC="${OLD_EXEC//$OLD_WD\/dist/$NEW_WD/dist}"

  # Decide whether checkout-local .state must move (only if the DB path is the
  # cwd-relative default, i.e. NOT pinned to an absolute path in the prod .env).
  DB_ABS=1; STATE_SRC=""; STATE_DST=""
  if [ -n "$db_rel" ]; then
    local pinned=""
    [ -n "$db_env" ] && [ -r "$OLD_ENV" ] && pinned="$(grep -E "^[[:space:]]*$db_env=" "$OLD_ENV" | tail -1 | cut -d'=' -f2- | tr -d '"'"'"' ' || true)"
    if [ -n "$pinned" ] && [ "${pinned#/}" != "$pinned" ]; then
      DB_ABS=1   # absolute path in .env -> DB stays put, no migration
    else
      DB_ABS=0
      STATE_SRC="$OLD_WD/${db_rel%/*}"   # e.g. <old_wd>/.state
      STATE_DST="$NEW_WD/${db_rel%/*}"
    fi
  fi
}

print_plan_one() {
  local key="$1"; derive "$key"
  local unit; unit="$(svc_field "$key" 2)"
  say "${c_bold}── $key ($unit) ──${c_rst}"
  say "  WorkingDirectory : $OLD_WD"
  say "                   ${c_grn}→ $NEW_WD${c_rst}"
  say "  EnvironmentFile  : ${OLD_ENV:-<none>}"
  say "                   ${c_grn}→ $NEW_ENV${c_rst}   ${c_dim}(copied from old)${c_rst}"
  say "  ExecStart        : $OLD_EXEC"
  say "                   ${c_grn}→ $NEW_EXEC${c_rst}"
  if [ -n "${STATE_SRC:-}" ] && [ "$DB_ABS" = "0" ]; then
    say "  state (sqlite)   : ${c_yel}MIGRATE${c_rst} $STATE_SRC ${c_grn}→ $STATE_DST${c_rst}"
    say "                     ${c_dim}(cwd-relative DB; holds OAuth/history — must move)${c_rst}"
  elif [ -n "$(svc_field "$key" 6)" ]; then
    say "  state (sqlite)   : ${c_grn}none to move${c_rst} ${c_dim}(DB path is absolute in .env)${c_rst}"
  else
    say "  state (sqlite)   : ${c_grn}none${c_rst} ${c_dim}(DB is an absolute CLI arg — vault dir)${c_rst}"
  fi
  say ""
}

cmd_plan() {
  require_box
  local target="${1:-all}"
  info "Dry-run plan (no changes). MONOREPO=$MONOREPO"
  say ""
  if [ "$target" = "all" ]; then
    for row in "${SERVICES[@]}"; do print_plan_one "${row%%|*}"; done
    say "Order to apply: ${c_bold}curator → engine${c_rst} (engine last)."
  else
    print_plan_one "$target"
  fi
}

# ----- apply one service -----
cmd_apply() {
  require_box
  local key="${1:?usage: apply <curator|engine>}"; derive "$key"
  local unit pkg port; unit="$(svc_field "$key" 2)"; pkg="$(svc_field "$key" 3)"; port="$(svc_field "$key" 4)"
  local dropin_dir="/etc/systemd/system/$unit.d"
  local dropin="$dropin_dir/zz-monorepo-cutover.conf"

  [ -x "$NEW_WD/dist" ] 2>/dev/null || [ -d "$NEW_WD/dist" ] || die "no build at $NEW_WD/dist — run 'preflight' first."

  print_plan_one "$key"
  confirm "Apply cutover for $key now? (stops $unit briefly)" || { warn "skipped $key"; return 0; }

  # 1. snapshot the current unit for forensics/rollback reference
  local backup="/tmp/cutover-${unit}-$(date +%s).unit.txt"
  systemctl cat "$unit" > "$backup" 2>/dev/null || true
  say "  saved current unit definition → $backup"

  # 2. stop the service (so a live SQLite .state copies cleanly)
  info "stopping $unit"
  sudo systemctl stop "$unit"

  # 3. relocate the prod .env into the package dir
  if [ -n "$OLD_ENV" ] && [ -r "$OLD_ENV" ]; then
    info "copy .env → $NEW_ENV"
    install -m 600 "$OLD_ENV" "$NEW_ENV"
  else
    warn "no readable EnvironmentFile at '$OLD_ENV' — make sure $NEW_ENV exists with the prod secrets."
  fi

  # 4. migrate checkout-local sqlite state if it lives cwd-relative
  if [ "$DB_ABS" = "0" ] && [ -d "$STATE_SRC" ]; then
    if [ -e "$STATE_DST" ]; then
      warn "$STATE_DST already exists — NOT overwriting. Verify it is the right DB."
    else
      info "migrate state $STATE_SRC → $STATE_DST"
      mkdir -p "$(dirname "$STATE_DST")"
      cp -a "$STATE_SRC" "$STATE_DST"
      ok "state copied (old left in place as rollback)"
    fi
  fi

  # 5. write the reversible systemd drop-in
  info "write drop-in $dropin"
  sudo mkdir -p "$dropin_dir"
  sudo tee "$dropin" >/dev/null <<EOF
# Generated by scripts/cutover.sh — vault-suite monorepo cutover.
# Reverts cleanly: delete this file, daemon-reload, restart $unit.
[Service]
WorkingDirectory=$NEW_WD
EnvironmentFile=
EnvironmentFile=$NEW_ENV
ExecStart=
ExecStart=$NEW_EXEC
EOF

  # 6. reload + start
  info "daemon-reload + start $unit"
  sudo systemctl daemon-reload
  sudo systemctl start "$unit"
  sleep 2
  systemctl is-active --quiet "$unit" && ok "$unit is active" || {
    warn "$unit is NOT active — recent logs:"; journalctl -u "$unit" -n 25 --no-pager || true
    die "cutover of $key failed to start. Roll back: ./scripts/cutover.sh rollback $key"
  }

  # 7. smoke
  smoke_one "$key" || warn "smoke check did not pass cleanly — inspect before moving on."
  ok "$key cut over. Old checkout left intact for rollback."
}

# ----- rollback one service -----
cmd_rollback() {
  require_box
  local key="${1:?usage: rollback <curator|engine>}"
  local unit; unit="$(svc_field "$key" 2)"
  local dropin="/etc/systemd/system/$unit.d/zz-monorepo-cutover.conf"
  [ -f "$dropin" ] || { warn "no cutover drop-in for $unit — nothing to roll back."; return 0; }
  confirm "Remove drop-in and restart $unit on the OLD paths?" || return 0
  sudo rm -f "$dropin"
  sudo systemctl daemon-reload
  sudo systemctl restart "$unit"
  sleep 2
  systemctl is-active --quiet "$unit" && ok "$unit rolled back and active" || {
    warn "still not active — logs:"; journalctl -u "$unit" -n 25 --no-pager || true; }
}

# ----- smoke -----
smoke_one() { # http reachability on localhost:<port>
  local key="$1" port code
  port="$(svc_field "$key" 4)"
  local path="/.well-known/oauth-protected-resource"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port$path" || echo 000)"
  if [ "$code" -ge 200 ] && [ "$code" -lt 500 ]; then
    ok "$key on :$port responded HTTP $code"
    return 0
  fi
  warn "$key on :$port returned HTTP $code (expected <500)"
  return 1
}

cmd_smoke() {
  require_box
  local target="${1:-all}"
  if [ "$target" = "all" ]; then
    local bad=0
    for row in "${SERVICES[@]}"; do smoke_one "${row%%|*}" || bad=1; done
    [ "$bad" = "0" ] && ok "all services responded" || warn "one or more services did not respond cleanly"
  else
    smoke_one "$target"
  fi
}

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    preflight) cmd_preflight "$@" ;;
    plan)      cmd_plan "$@" ;;
    apply)     cmd_apply "$@" ;;
    rollback)  cmd_rollback "$@" ;;
    smoke)     cmd_smoke "$@" ;;
    ""|-h|--help|help) usage ;;
    *) die "unknown command '$cmd' (preflight|plan|apply|rollback|smoke)" ;;
  esac
}
main "$@"
