# telegram-delegate

Стас отдаёт задачу коллеге: коллега пишет Telegram-боту в личку и говорит напрямую с отдельной сессией Claude Code (сессия-ребёнок head-сессии Стаса).

- **Роутер** (`src/router/`) - долгоживущий процесс на pc-virt. Владеет ботом (long polling), держит маршруты "гость -> sessionId", HTTP API на `127.0.0.1:8790`.
- **Канал-сервер** (`src/channel/`) - stdio MCP-сервер (Claude Code Channels) внутри сессии-ребёнка. Держит SSE-подписку на роутер.

Дизайн: [docs/design.md](docs/design.md), план: [docs/plan.md](docs/plan.md).

## Разработка

```bash
npm install
npm test
npm run typecheck
```

Node 24, `.ts` запускается напрямую (`node file.ts`), без сборки.

## Роутер: установка и запуск (pc-virt)

```bash
deploy/install.sh                       # unit в ~/.config/systemd/user, каталоги, шаблон config.json; .env НЕ создаёт
# Стас вписывает секреты в ~/.config/telegram-delegate/.env (права 600):
#   TELEGRAM_BOT_TOKEN=...
#   DEEPGRAM_API_KEY=...
systemctl --user enable --now telegram-delegate
journalctl --user -u telegram-delegate -n 20   # "polling as @<бот>"
```

Без `TELEGRAM_BOT_TOKEN` роутер выходит с кодом 1.

## Файлы

| Путь | Кто пишет | Что |
|---|---|---|
| `~/.config/telegram-delegate/.env` | только Стас | `TELEGRAM_BOT_TOKEN`, `DEEPGRAM_API_KEY` |
| `~/.config/telegram-delegate/config.json` | install.sh (шаблон), Стас | `adminUserId`, `port` (8790), `idleHours` (24), `lostGraceSec` (60), `deepgram.language` (ru), `deepgram.model` (по умолчанию nova-3) |
| `~/.config/telegram-delegate/api-token` | роутер при первом старте (600) | Bearer-токен локального API |
| `~/.local/state/telegram-delegate/routes.json` | роутер | маршруты "гость -> sessionId" |
| `~/.local/state/telegram-delegate/inbox/<sessionId>/` | роутер | файлы и голосовые гостя |
| `~/.local/state/telegram-delegate/mcp/<sessionId>.json` | скилл telegram-delegate | MCP-конфиг сессии-ребёнка |

Пути учитывают `XDG_CONFIG_HOME` / `XDG_STATE_HOME`.

## API роутера

`127.0.0.1:8790`, все запросы с `Authorization: Bearer <api-token>`.

| Метод и путь | Что |
|---|---|
| `GET /health` | `{ ok, botUsername }` |
| `GET /routes` | `{ routes }` |
| `POST /routes` | `{ sessionId, sessionName, headId, tgUsername?, tgUserId? }` -> 201 `{ route, moved? }` |
| `DELETE /routes/:sessionId` | маршрут -> `closed` |
| `GET /sessions/:id/events` | SSE для канал-сервера; подключение делает маршрут `active` |
| `POST /sessions/:id/reply` | `{ text, files?, reply_to? }` -> `{ message_ids }`; 409 пока гость не писал боту |
| `POST /sessions/:id/edit` | `{ message_id, text }` |
| `POST /sessions/:id/permission` | `{ request_id, tool_name, description, input_preview }` -> кнопки гостю |

Обрыв подписки active-маршрута дольше `lostGraceSec` -> `lost` и сообщение админу.
