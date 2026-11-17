#!/usr/bin/env bash
# Installs the telegram-delegate systemd user unit and creates config/state dirs.
# Does NOT create .env with secrets and does NOT enable or start the service.
# TD_NO_SYSTEMCTL=1 skips `systemctl --user daemon-reload` (for checks in a scratch HOME).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/telegram-delegate"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/telegram-delegate"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$unit_dir"
install -m 0644 "$here/telegram-delegate.service" "$unit_dir/telegram-delegate.service"
echo "unit: $unit_dir/telegram-delegate.service"

mkdir -p "$config_dir" "$state_dir/inbox" "$state_dir/mcp"
chmod 700 "$config_dir" "$state_dir"

if [ ! -e "$config_dir/config.json" ]; then
  cat > "$config_dir/config.json" <<'JSON'
{
  "adminUserId": "241225329",
  "port": 8790,
  "idleHours": 24,
  "lostGraceSec": 60,
  "writeFirst": false,
  "deepgram": { "language": "ru" }
}
JSON
  chmod 600 "$config_dir/config.json"
  echo "config: $config_dir/config.json (создан)"
else
  echo "config: $config_dir/config.json (уже есть, не трогаю)"
fi

if [ "${TD_NO_SYSTEMCTL:-}" != "1" ]; then
  systemctl --user daemon-reload
fi

env_file="$config_dir/.env"
if [ -e "$env_file" ]; then
  echo ".env: $env_file есть"
else
  cat <<MSG

Секреты вписывает Стас (агенты этот файл не создают и не читают):
  $env_file   (права 600)
    TELEGRAM_BOT_TOKEN=<токен нового бота из BotFather>
    DEEPGRAM_API_KEY=<ключ Deepgram>
MSG
fi
cat <<MSG

Запуск (задача 10, вместе со Стасом):
  systemctl --user enable --now telegram-delegate
  journalctl --user -u telegram-delegate -n 20
MSG
