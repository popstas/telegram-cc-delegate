# telegram-delegate

Роутер Telegram-бота + MCP канал-сервер для Claude Code Channels. Дизайн и план - `data/docs/design.md`, `data/docs/plan.md` (папка локальная, в git не входит, у чекаута с GitHub её нет).

## Правила

- Node 24, TypeScript без сборки (type stripping): без `enum`/`namespace`/parameter properties, импорты с `.ts`.
- Проверка: `npm test && npm run typecheck`.
- Тексты бота - en и ru в `src/texts.ts`; в русских дефис `-` вместо длинного тире, обычные кавычки `"`.
- Секреты (`TELEGRAM_BOT_TOKEN`, `DEEPGRAM_API_KEY`) в `~/.config/telegram-delegate/.env` вписывает только владелец. Не читать, не печатать, не коммитить.
- `~/.claude/channels/telegram` и плагин `telegram@claude-plugins-official` не трогать.
- Роутер слушает только `127.0.0.1`.
- В тестах Telegram и Deepgram только фейки, без сети.
