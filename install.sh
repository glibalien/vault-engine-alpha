#!/usr/bin/env bash
# Install Vault Engine and Vault Curator from this checkout: check the prerequisites,
# install dependencies and build, then run the terminal installer, which asks every
# question and changes nothing until you approve its review.
#
#   ./install.sh                         interactive install
#   ./install.sh --answers a.json --yes  headless install
#   ./install.sh plan | status | undo | uninstall
#                                        the installer's other commands
#
# Any options are passed to `vault-installer`; with no command, `install` is assumed.
set -euo pipefail
# Everything this script prints goes to stderr, so `plan --json` keeps stdout to the JSON.
exec 3>&1 1>&2

# The folder this was run from, before moving into the checkout to build.
CALLER_DIR="$PWD"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

warn() {
  echo "install.sh: warning: $*" >&2
}

case "${1:-}" in
  plan | install | status | undo | uninstall | -h | --help | --version) ;;
  *) set -- install "$@" ;;
esac
# This run again, as a command to copy.
AGAIN="$(printf %q "$REPO_ROOT/install.sh")$(printf ' %q' "$@")"

# Linux runs the services under systemd; macOS as launchd agents for the user.
os="$(uname -s)"
case "$os" in
  Linux | Darwin) ;;
  *) fail "Vault Suite installs on Linux with systemd, and on macOS on Apple Silicon." ;;
esac

# Asking for the help or the version installs nothing (the installer answers those before
# any command), so it skips the install checks below.
checks=''
if [ "$1" = install ]; then
  checks=1
  for arg in "$@"; do
    case "$arg" in -h | --help | --version) checks='' ;; esac
  done
fi

# Before an install, the cheap checks that would stop it run here, ahead of the build. The
# installer's preflight checks everything again and stays the authority.
if [ -n "$checks" ] && [ "$os" = Darwin ]; then
  command -v launchctl > /dev/null 2>&1 \
    || fail "Vault Suite runs Engine and Curator as launchd agents, and launchctl was not found."
  [ "$(id -u)" != 0 ] \
    || warn "running as root. Run install.sh as the user who will own the vault; the services run as that user while they are logged in."
elif [ -n "$checks" ]; then
  { command -v systemctl > /dev/null 2>&1 && [ "$(systemctl is-system-running 2> /dev/null)" != offline ]; } \
    || fail "Vault Suite runs Engine and Curator as systemd services, and this system is not running systemd."
  [ "$(id -u)" != 0 ] \
    || warn "running as root. Run install.sh as the user who will own the vault and the services; it asks for sudo only when it installs them."
fi

# A wrong or missing Node.js stops here, with the exact command for each version manager
# found on this machine.
want="$(tr -d 'v[:space:]' < .nvmrc | cut -d. -f1)"
need_node() {
  echo "install.sh: Node.js $want is required, $*. To get it and run this again:"
  local found=''
  if command -v mise > /dev/null 2>&1; then
    found=1
    echo "  with mise:  mise install node@$want && PATH=\"\$(mise where node@$want)/bin:\$PATH\" $AGAIN"
  fi
  local nvm_sh="${NVM_DIR:-${HOME:-}/.nvm}/nvm.sh"
  if [ -s "$nvm_sh" ]; then
    found=1
    # nvm is a shell function that only exists once nvm.sh is loaded.
    echo "  with nvm:   . $(printf %q "$nvm_sh") && nvm install $want && nvm use $want && $AGAIN"
  fi
  if command -v fnm > /dev/null 2>&1; then
    found=1
    echo "  with fnm:   fnm install $want && fnm use $want && $AGAIN"
  fi
  [ -n "$found" ] || echo "  Install Node.js $want from https://nodejs.org, or with a version manager such as mise, nvm, or fnm."
  exit 1
}
command -v node > /dev/null 2>&1 || need_node "and node was not found"
[ "$(node -p 'process.versions.node.split(".")[0]')" = "$want" ] \
  || need_node "but node is $(node --version); the services run on the Node.js that builds them"
command -v npm > /dev/null 2>&1 || fail "npm, which comes with Node.js, is required."
# Engine's local search model (onnxruntime-node) ships no Intel Mac build. Node.js's own
# architecture is what counts: an x64 Node.js runs under Rosetta on an Apple Silicon Mac.
if [ "$os" = Darwin ]; then
  arch="$(node -p process.arch)"
  [ "$arch" = arm64 ] \
    || fail "Node.js here runs as $arch. Engine's local search model has no build for Intel Macs, so Vault Suite needs an Apple Silicon Mac and the arm64 Node.js $want."
fi

if [ -n "$checks" ]; then
  # The installer's default ports (layout.ts), for a fresh install only: a saved install in
  # the default data directory, --data-dir, and other ports are left to the installer.
  fresh=1
  for arg in "$@"; do
    case "$arg" in --engine-port | --curator-port | --data-dir) fresh='' ;; esac
  done
  if [ -e "${HOME:-}/vault-suite-data/installer/state.json" ]; then fresh=''; fi
  if [ -n "$fresh" ]; then
    for port in 3334 3335; do
      node -e '
        const server = require("node:net").createServer();
        server.once("error", () => process.exit(1));
        server.listen({ port: Number(process.argv[1]), host: "127.0.0.1", exclusive: true }, () => server.close());
      ' "$port" \
        || fail "port $port is in use. Another program, or an earlier Vault installation, is listening there. Stop it, or choose other ports with --engine-port and --curator-port."
    done
  fi
  free="$(node -p 'const disk = require("node:fs").statfsSync(process.argv[1]); (disk.bavail * disk.bsize / 1024 ** 3).toFixed(1)' "$REPO_ROOT" 2> /dev/null)" || free=''
  if [ -n "$free" ] && [ "${free%.*}" -lt 2 ]; then
    warn "only $free GB is free for $REPO_ROOT. Dependencies, service state, backups, and the search model need about 2 GB."
  fi
fi

# The build's output goes to a log, shown when a step fails.
log="$(mktemp "${TMPDIR:-/tmp}/vault-install.XXXXXX")"
quietly() {
  echo "\$ $*" >> "$log"
  "$@" >> "$log" 2>&1 && return
  echo "install.sh: '$*' failed. The end of its output:"
  tail -n 40 "$log" | sed 's/^/  /'
  fail "The full output is in $log."
}

# Install dependencies when they are missing, older than the lockfile, or built for another
# Node.js: better-sqlite3's native binary only loads on the Node.js ABI it was built for.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ] \
  || ! node -e 'new (require("better-sqlite3"))(":memory:").close()' > /dev/null 2>&1; then
  echo "▶ Preparing: installing dependencies and building, about 3 minutes (output in $log)"
  # sharp compiles from source (and fails) when the host has a system libvips it
  # considers new enough; use its prebuilt binary instead.
  quietly env SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci
else
  echo "▶ Preparing: building, about a minute (output in $log)"
fi
quietly npm run build
rm -f "$log"

echo "▶ vault-installer $1"
# The installer records this Node.js binary for the services it installs; it gets the
# original stdout back.
# `vault-installer` is not on PATH, so the installer's messages name this script instead.
export VAULT_INSTALLER_COMMAND="$REPO_ROOT/install.sh"
# Relative paths in the options, and the notes folder it first suggests, mean the folder
# this was run from, not the checkout.
export VAULT_INSTALLER_CWD="$CALLER_DIR"
exec node packages/installer/dist/cli.js "$@" 1>&3 3>&-
