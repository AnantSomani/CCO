#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
TUNNEL_NAME="${CLOUDFLARED_TUNNEL_NAME:-confetti-dev}"
HOSTNAME="${CLOUDFLARED_HOSTNAME:-dashboard.tryconfetti.xyz}"
APP_BASE_URL="https://$HOSTNAME"
TUNNEL_TOKEN="${CLOUDFLARED_TUNNEL_TOKEN:-}"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required but was not found on PATH."
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is required but was not found on PATH."
  echo "Install it with: brew install cloudflared"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo ".env.local not found at $ENV_FILE"
  exit 1
fi

DOORDASH_EXECUTOR="$(python3 - "$ENV_FILE" <<'PY'
import pathlib
import sys

for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if line.startswith("DOORDASH_EXECUTOR="):
        print(line.split("=", 1)[1].strip())
        break
else:
    print("disabled")
PY
)"

if [[ "$DOORDASH_EXECUTOR" == "dd-cli" ]]; then
  if ! command -v dd-cli >/dev/null 2>&1; then
    echo "DOORDASH_EXECUTOR=dd-cli, but dd-cli was not found on PATH."
    exit 1
  fi
  DD_INTENT=$'Summary: Verify DoorDash preview access for the local Confetti developer\nuser prompt/purpose: "Start the local Confetti development stack"'
  if ! dd-cli --json-output address list --intent "$DD_INTENT" >/dev/null; then
    echo "DoorDash authentication check failed. Run: dd-cli login"
    exit 1
  fi
  echo "DoorDash preview executor is available and authenticated."
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/confetti-dev.XXXXXX")"
CLOUDFLARED_LOG="$TMP_DIR/cloudflared.log"
NEXT_LOG="$TMP_DIR/next.log"
INNGEST_LOG="$TMP_DIR/inngest.log"

CLOUDFLARED_PID=""
NEXT_PID=""
INNGEST_PID=""

cleanup() {
  for pid in "$INNGEST_PID" "$NEXT_PID" "$CLOUDFLARED_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}

trap cleanup EXIT INT TERM

python3 - "$ENV_FILE" "$APP_BASE_URL" <<'PY'
import pathlib
import sys

env_path = pathlib.Path(sys.argv[1])
app_base_url = sys.argv[2]
lines = env_path.read_text().splitlines()

updated = False
for i, line in enumerate(lines):
    if line.startswith("APP_BASE_URL="):
        lines[i] = f"APP_BASE_URL={app_base_url}"
        updated = True
        break

if not updated:
    lines.append(f"APP_BASE_URL={app_base_url}")

env_path.write_text("\n".join(lines) + "\n")
PY

echo "Updated APP_BASE_URL in .env.local"
echo "Starting Next.js dev server..."
(cd "$ROOT_DIR" && pnpm dev) >"$NEXT_LOG" 2>&1 &
NEXT_PID=$!

echo "Starting Inngest dev server..."
(cd "$ROOT_DIR" && npx inngest-cli@latest dev) >"$INNGEST_LOG" 2>&1 &
INNGEST_PID=$!

if [[ -n "$TUNNEL_TOKEN" ]]; then
  TUNNEL_AUTH_MODE="token"
  echo "Starting named Cloudflare tunnel with token: $TUNNEL_NAME"
  cloudflared tunnel run --token "$TUNNEL_TOKEN" >"$CLOUDFLARED_LOG" 2>&1 &
else
  TUNNEL_AUTH_MODE="credentials-file"
  echo "Starting named Cloudflare tunnel: $TUNNEL_NAME"
  cloudflared tunnel run "$TUNNEL_NAME" >"$CLOUDFLARED_LOG" 2>&1 &
fi
CLOUDFLARED_PID=$!

sleep 3

if ! kill -0 "$CLOUDFLARED_PID" >/dev/null 2>&1; then
  echo "The named tunnel failed to start."
  echo "Check: $CLOUDFLARED_LOG"
  exit 1
fi

cat <<EOF

Dev stack is starting.

APP_BASE_URL
  $APP_BASE_URL

Inngest endpoint
  $APP_BASE_URL/api/inngest

Tunnel
  Name: $TUNNEL_NAME
  Hostname: $HOSTNAME
  Auth: $TUNNEL_AUTH_MODE

Slack URLs
  Commands:       $APP_BASE_URL/api/slack/commands
  Events:         $APP_BASE_URL/api/slack/events
  Interactivity:  $APP_BASE_URL/api/slack/interactivity
  OAuth callback: $APP_BASE_URL/api/slack/oauth_callback

Logs
  cloudflared: $CLOUDFLARED_LOG
  next:        $NEXT_LOG
  inngest:     $INNGEST_LOG

Keep this terminal open. Press Ctrl-C to stop everything.
EOF

wait
