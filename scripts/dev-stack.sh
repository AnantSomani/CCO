#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"

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

echo "Starting Cloudflare quick tunnel..."
cloudflared tunnel --url http://localhost:3000 >"$CLOUDFLARED_LOG" 2>&1 &
CLOUDFLARED_PID=$!

APP_BASE_URL=""
for _ in $(seq 1 60); do
  APP_BASE_URL="$(python3 - "$CLOUDFLARED_LOG" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(errors="ignore")
match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", text)
print(match.group(0) if match else "")
PY
)"
  if [[ -n "$APP_BASE_URL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$APP_BASE_URL" ]]; then
  echo "Could not detect the quick tunnel URL."
  echo "Check: $CLOUDFLARED_LOG"
  exit 1
fi

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

sleep 2

cat <<EOF

Dev stack is starting.

APP_BASE_URL
  $APP_BASE_URL

Inngest endpoint
  $APP_BASE_URL/api/inngest

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
