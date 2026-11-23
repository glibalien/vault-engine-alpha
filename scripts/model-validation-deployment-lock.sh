#!/usr/bin/env bash

model_validation_lock_error() {
  printf '%s\n' "[model-validation-lock] ERROR: $1" >&2
}

model_validation_lock_path() {
  local repo_root="$1" raw_path absolute_path
  raw_path="$(git -C "$repo_root" rev-parse --git-path vault-engine-deploy.lock)" || {
    model_validation_lock_error "could not resolve lock path for $repo_root"
    return 1
  }
  [ -n "$raw_path" ] || {
    model_validation_lock_error "Git returned an empty lock path for $repo_root"
    return 1
  }
  case "$raw_path" in
    /*) absolute_path="$raw_path" ;;
    *) absolute_path="$repo_root/$raw_path" ;;
  esac
  [ ! -L "$absolute_path" ] || {
    model_validation_lock_error "lock path must not be a symlink: $absolute_path"
    return 1
  }
  realpath -m -- "$absolute_path"
}

model_validation_acquire_lock() {
  local repo_root="$1" mode="$2" actor="$3" lock_path
  [ "$mode" = existing ] || [ "$mode" = create ] || {
    model_validation_lock_error "invalid lock mode: $mode"
    return 1
  }
  command -v flock >/dev/null 2>&1 || {
    model_validation_lock_error 'flock is required'
    return 1
  }
  lock_path="$(model_validation_lock_path "$repo_root")" || return 1
  if [ "$mode" = create ] && [ ! -e "$lock_path" ]; then
    [ -d "$(dirname -- "$lock_path")" ] || {
      model_validation_lock_error "lock parent is missing: $(dirname -- "$lock_path")"
      return 1
    }
    (umask 077; : > "$lock_path") || {
      model_validation_lock_error "could not create lock: $lock_path"
      return 1
    }
  fi
  [ -f "$lock_path" ] && [ ! -L "$lock_path" ] || {
    model_validation_lock_error "existing regular lock file is required: $lock_path"
    return 1
  }
  exec {MODEL_VALIDATION_LOCK_FD}<"$lock_path" || {
    model_validation_lock_error "could not open lock read-only: $lock_path"
    return 1
  }
  flock -n "$MODEL_VALIDATION_LOCK_FD" || {
    model_validation_lock_error "deployment/model-validation lock is held; $actor cannot overlap: $lock_path"
    return 1
  }
  MODEL_VALIDATION_LOCK_PATH="$lock_path"
}
