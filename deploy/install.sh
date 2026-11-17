#!/usr/bin/env bash
# Installs the telegram-delegate systemd user unit and creates the config and state dirs.
# Does NOT create .env with secrets and does NOT enable or start the service.
# NODE=/path/to/node overrides the node binary (default: `command -v node`, Node 24+).
# TD_NO_SYSTEMCTL=1 skips `systemctl --user daemon-reload` (for checks in a scratch HOME).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
app_dir="$(cd "$here/.." && pwd)"
node_bin="${NODE:-$(command -v node || true)}"
if [ -z "$node_bin" ]; then
  echo "node not found in PATH, set NODE=/path/to/node (Node 24+)" >&2
  exit 1
fi
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/telegram-delegate"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/telegram-delegate"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

case "$app_dir$node_bin" in
  *'|'*|*'&'*|*'\'*) echo "unsupported characters in $app_dir or $node_bin" >&2; exit 1 ;;
esac

mkdir -p "$unit_dir"
sed -e "s|@NODE@|$node_bin|g" -e "s|@APP_DIR@|$app_dir|g" "$here/telegram-delegate.service" > "$unit_dir/telegram-delegate.service"
chmod 0644 "$unit_dir/telegram-delegate.service"
echo "unit: $unit_dir/telegram-delegate.service (node: $node_bin, app: $app_dir)"

mkdir -p "$config_dir" "$state_dir/inbox" "$state_dir/mcp"
chmod 700 "$config_dir" "$state_dir"

config_file="$config_dir/config.json"
if [ ! -e "$config_file" ]; then
  cat > "$config_file" <<'JSON'
{
  "adminUserId": "YOUR_TELEGRAM_USER_ID",
  "language": "en",
  "port": 8790,
  "idleHours": 24,
  "lostGraceSec": 60,
  "writeFirst": false
}
JSON
  chmod 600 "$config_file"
  echo "config: $config_file (created)"
  echo "  Put your numeric Telegram user id into \"adminUserId\" (for example, ask @userinfobot), the router will not start without it."
else
  echo "config: $config_file (exists, left as is)"
fi

if [ "${TD_NO_SYSTEMCTL:-}" != "1" ]; then
  systemctl --user daemon-reload
fi

env_file="$config_dir/.env"
if [ -e "$env_file" ]; then
  echo ".env: $env_file exists"
else
  cat <<MSG

Create the secrets file yourself (mode 600):
  $env_file
    TELEGRAM_BOT_TOKEN=<bot token from @BotFather>
    DEEPGRAM_API_KEY=<Deepgram key, optional: voice messages are transcribed only with it>
MSG
fi
cat <<MSG

Start:
  systemctl --user enable --now telegram-delegate
  journalctl --user -u telegram-delegate -n 20
MSG
