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
