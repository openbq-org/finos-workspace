#!/usr/bin/env bash
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$LOCAL_DIR/../backend-api/backend"
BACKEND_ENV="$BACKEND_DIR/envs/.env"
PORTS=(3306 6379 8000 1420)
APP_URL="http://localhost:1420"
API_HEALTH_URL="http://localhost:8000/health"
WAIT_SECONDS="${WAIT_SECONDS:-1200}"

usage() {
  cat <<USAGE
Usage: ./dev.sh <command>

Commands:
  doctor   Check Docker, Docker Compose and free ports
  env      Create the backend's settings and the first administrator if they are missing
  wait     Wait until the backend and the frontend answer, then print where to sign in

Options:
  -h, --help   Show this help

Environment:
  ADMIN_EMAIL    Email address of the first administrator; needed by 'env' when the
                 settings do not exist yet
  WAIT_SECONDS   How long 'wait' waits before giving up (default: 1200)
USAGE
}

fail() {
  echo "error: $*" >&2
  exit 1
}

compose() {
  docker compose --project-directory "$LOCAL_DIR" "$@"
}

doctor() {
  command -v docker >/dev/null || fail "Docker is not installed. Install Docker Desktop."
  docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker Desktop."
  local version
  version="$(docker compose version --short 2>/dev/null)" || fail "Docker Compose v2 is missing. Update Docker Desktop."
  echo "ok: Docker Compose ${version#v}"

  if command -v lsof >/dev/null && [[ -z "$(compose ps -q 2>/dev/null)" ]]; then
    local port
    for port in "${PORTS[@]}"; do
      if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        fail "port $port is in use. See what holds it with: lsof -nP -iTCP:$port -sTCP:LISTEN"
      fi
    done
    echo "ok: ports ${PORTS[*]} are free"
  fi
}

create_env() {
  if [[ -f "$BACKEND_ENV" ]]; then
    echo "ok: using the existing backend-api/backend/envs/.env"
    return
  fi
  [[ -n "${ADMIN_EMAIL:-}" ]] ||
    fail "backend-api/backend/envs/.env does not exist yet. Name the administrator: ADMIN_EMAIL=<your-email> make up"
  command -v python3 >/dev/null || fail "python3 is needed once to write the settings (standard library only)."
  (cd "$BACKEND_DIR" && python3 -m scripts.create_local_env --admin-email "$ADMIN_EMAIL")
}

wait_ready() {
  local deadline=$((SECONDS + WAIT_SECONDS)) init_state
  echo "Waiting for the backend and the frontend (the first run builds images and installs packages)..."
  until curl -fs -o /dev/null "$API_HEALTH_URL" && curl -fs -o /dev/null "$APP_URL"; do
    init_state="$(compose ps --all --format '{{.State}} {{.ExitCode}}' init 2>/dev/null || true)"
    if [[ "$init_state" == exited* && "$init_state" != "exited 0" ]]; then
      fail "the init step failed. See why with: make logs s=init"
    fi
    (( SECONDS < deadline )) || fail "not ready after ${WAIT_SECONDS}s. See: make logs"
    sleep 5
  done
  local admin_email
  admin_email="$(python3 - "$BACKEND_DIR/scripts/cfgs/config.toml" <<'PY' 2>/dev/null || true
import sys, tomllib
with open(sys.argv[1], "rb") as handle:
    print(tomllib.load(handle)["admins"][0]["email"])
PY
)"
  cat <<READY

Ready.
  App:      $APP_URL
  Backend:  http://localhost:8000
  Sign in:  as the administrator in backend-api/backend/scripts/cfgs/config.toml. The account
            has no password until you set it, once, typed twice and not shown. In this folder:

              docker compose run --rm init python -m scripts.init_users --new-password ${admin_email:-<your-email>}

  Agents:   three extra MODE=local-only admins are also seeded with known passwords
            so other agents can sign in alongside you:

              workspace-dev1@example.com  WorkspaceDev!1
              workspace-dev2@example.com  WorkspaceDev!2
              workspace-dev3@example.com  WorkspaceDev!3
READY
}

case "${1:-}" in
  doctor) doctor ;;
  env) create_env ;;
  wait) wait_ready ;;
  -h | --help) usage ;;
  *)
    usage >&2
    exit 1
    ;;
esac
