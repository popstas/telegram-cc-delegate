# telegram-delegate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Стас одной командой в своей head-сессии отдаёт задачу коллеге: открывается сессия-ребёнок со сводкой, коллега говорит с ней через Telegram-бота напрямую, ребёнок докладывает head.

**Architecture:** Долгоживущий роутер на pc-virt владеет ботом и маршрутами "гость → sessionId" и держит localhost HTTP API. В каждой сессии-ребёнке Claude Code запускает тонкий stdio MCP канал-сервер (Channels, `--dangerously-load-development-channels`), который держит SSE-подписку на роутер: обрыв подписки = сессия ушла. Ребёнка открывает session-spawn окном claude-wt; флаги канала доезжают через файлы рядом с заданием, которые читает обёртка `claude-wt-new`.

**Tech Stack:** Node 24 (TypeScript запускается напрямую, type stripping), grammy, @modelcontextprotocol/sdk, zod, vitest; bash + pytest для обёртки; node:test для скиллов.

**Spec:** `Notes/2026/11/telegram-delegate - дизайн 2026-11-17.md` (вольт ExpertizeMe, `/home/popstas/projects/text/obsidian/ExpertizeMe`). Варианты и сравнение: `Notes/2026/11/Прямой доступ коллеги к агенту - варианты 2026-11-17.md`.

**Исполнители (head-session):** задачи 1-6 - репо `~/projects/js/telegram-delegate`; задача 7 - репо `~/projects/shell/ccfzf`; задачи 8-9 - репо `~/.claude/skills`; задача 10 - head вместе со Стасом. Зоны не пересекаются, 7 и 8 можно вести параллельно с 1-6.

## Global Constraints

- Node 24, `.ts` запускается `node file.ts` без сборки: без `enum`/`namespace`/parameter properties, импорты с расширением `.ts`, `tsconfig` с `allowImportingTsExtensions`, `noEmit`, `verbatimModuleSyntax`; проверка типов `npx tsc`.
- Секреты (`TELEGRAM_BOT_TOKEN`, `DEEPGRAM_API_KEY`) вписывает только Стас в `~/.config/telegram-delegate/.env`. Агенты их не читают, не печатают и не пишут в git.
- Бот новый. `~/.claude/channels/telegram` и плагин `telegram@claude-plugins-official` не трогать.
- Роутер слушает только `127.0.0.1`, порт по умолчанию `8790`. Все запросы к API - с `Authorization: Bearer <токен>` из `~/.config/telegram-delegate/api-token` (права 600, роутер генерирует при первом старте, 32 байта hex).
- Состояние: `~/.local/state/telegram-delegate/routes.json`, входящие файлы `~/.local/state/telegram-delegate/inbox/<sessionId>/`, MCP-конфиги ребёнка `~/.local/state/telegram-delegate/mcp/<sessionId>.json`.
- Конфиг: `~/.config/telegram-delegate/config.json` - `{ "adminUserId": "241225329", "port": 8790, "idleHours": 24, "lostGraceSec": 60, "deepgram": { "language": "ru" } }`, модель Deepgram - по скиллу `deepgram:api` (prerecorded STT для русского).
- Telegram: отправка без `parse_mode` (простой текст), нарезка по 4096 символов с предпочтением перевода строки. Сообщения не из private chat игнорируются целиком.
- Тексты на русском - правила вольта: без длинного тире (дефис `-`), без «ёлочек» (обычные `"`).
- Фиксированные тексты бота:
  - нет маршрута или он закрыт: `Для вас сейчас нет активной сессии.`
  - маршрут ждёт сессию: `Сессия запускается, напишите через минуту.`
  - сессия потеряна: `Сессия прервалась, Стас в курсе.`
  - гость прислал `/stop`: `Сессия завершена.`
  - чужое нажатие кнопки: `Not authorized.`; устаревший запрос: `Запрос устарел.`
- Тексты админу (личка `adminUserId` от того же бота), префикс `telegram-delegate: `:
  - обрыв: `сессия <sessionName> (<sessionId>) гостя <гость> прервалась без stop.`
  - простой: `гость <гость> молчит <idleHours> ч, сессия <sessionName> открыта.`
  - перенос: `маршрут <гость> перенесён из <старая sessionName> в <новая sessionName>.`
  - где `<гость>` = `@username`, а без него numeric id.
- Выкатка на Windows (nb) не нужна: меняются только pc-virt (`~/bin/claude-wt-new` - симлинк в ccfzf, `~/.claude/skills`, systemd user unit).

## Review Focus

1. Гость без username или сменивший его: маршрут по username должен один раз закрепить `tgUserId` и дальше матчить по id. Тест - задача 1 (`matchSender pins id`).
2. Пишет Стас, посторонний или кто-то из группы: посторонний получает `Для вас сейчас нет активной сессии.`, групповые сообщения игнорируются без ответа, в сессию не попадает ничего. Тест - задача 3.
3. Роутер перезапустился при живых сессиях: маршруты грузятся из файла, канал-серверы переподключаются; активный маршрут без подписки дольше `lostGraceSec` становится `lost` с уведомлением админу. Тесты - задачи 2 и 6.
4. Длинный ответ агента или текст со спецсимволами Markdown: режется на куски ≤4096, уходит простым текстом. Тест - задача 3 (`chunk`).
5. Кнопку подтверждения нажимает не гость или запрос устарел (сессия перезапустилась): вердикт в сессию не уходит, нажавшему - `Not authorized.` / `Запрос устарел.`. Тест - задача 3.

---

### Task 1: Каркас репо и хранилище маршрутов

**Files:**
- Create: `~/projects/js/telegram-delegate/package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`, `AGENTS.md` (+ симлинк `CLAUDE.md` → `AGENTS.md`), `docs/design.md` (копия спеки), `docs/plan.md` (копия этого плана)
- Create: `src/routes.ts`, `src/config.ts`
- Test: `test/routes.test.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type RouteStatus = 'pending' | 'active' | 'lost' | 'closed'
  interface Route { sessionId: string; sessionName: string; headId: string; tgUsername?: string; tgUserId?: string; status: RouteStatus; createdAt: number; lastMessageAt?: number; idleNotifiedAt?: number }
  interface RouteInput { sessionId: string; sessionName: string; headId: string; tgUsername?: string; tgUserId?: string }
  class RouteStore {
    constructor(file: string)
    upsert(input: RouteInput, now: number): { route: Route; moved?: Route }
    matchSender(from: { id: string; username?: string }): Route | undefined
    get(sessionId: string): Route | undefined
    list(): Route[]
    setStatus(sessionId: string, status: RouteStatus): Route | undefined
    touch(sessionId: string, now: number): void
    idleCandidates(now: number, idleMs: number): Route[]
    markIdleNotified(sessionId: string, now: number): void
  }
  function guestLabel(r: Route): string            // "@username" или id
  interface Config { adminUserId: string; port: number; idleHours: number; lostGraceSec: number; deepgram: { language: string; model?: string }; botToken?: string; deepgramKey?: string; stateDir: string; configDir: string }
  function loadConfig(env?: NodeJS.ProcessEnv): Config  // config.json + .env, умолчания из Global Constraints
  function ensureApiToken(configDir: string): string    // читает или создаёт api-token с правами 600
  ```

- [ ] **Step 1: Write the failing tests** `test/routes.test.ts`:
  - `upsert creates pending route` - новый маршрут `status === 'pending'`, файл на диске содержит его.
  - `upsert same sessionId updates fields without move` - второй upsert с тем же sessionId меняет `sessionName`, `moved` undefined.
  - `upsert moves active route of same user` - маршрут A (`tgUsername: 'alexiapost'`, active), upsert B с `tgUsername: '@AlexiaPost'` → `moved.sessionId === A`, `get(A).status === 'closed'`.
  - `matchSender pins id` - маршрут только с username; `matchSender({id: '42', username: 'alexiapost'})` возвращает его и ставит `tgUserId === '42'`; затем `matchSender({id: '42', username: 'renamed'})` всё ещё находит; `matchSender({id: '43', username: 'alexiapost'})` - undefined (id уже закреплён за другим).
  - `matchSender ignores closed routes`.
  - `store survives reload` - новый `RouteStore(file)` видит те же маршруты.
  - `idleCandidates` - active-маршрут с `lastMessageAt` старше `idleMs` и без `idleNotifiedAt` попадает, после `markIdleNotified` - нет.
  `test/config.test.ts`: `ensureApiToken creates 600 file once` (второй вызов возвращает тот же токен, `stat.mode & 0o777 === 0o600`); `loadConfig defaults` (`port 8790`, `idleHours 24`, `lostGraceSec 60`) на пустом каталоге.
- [ ] **Step 2: Run** `npx vitest run test/routes.test.ts test/config.test.ts` - Expected: FAIL (модули не найдены).
- [ ] **Step 3: Implement** `src/routes.ts` (запись атомарно: tmp + rename, username сравнивается без `@` и без учёта регистра) и `src/config.ts` (пути через `XDG_CONFIG_HOME`/`XDG_STATE_HOME` с умолчаниями `~/.config`, `~/.local/state`; `.env` парсить самим, без зависимостей). Каркас: `package.json` `"type": "module"`, скрипты `test` (`vitest run`), `typecheck` (`tsc`), `start` (`node src/router/main.ts`).
- [ ] **Step 4: Run** `npm test && npm run typecheck` - Expected: PASS.
- [ ] **Step 5: Commit** `git init`, `git add -A`, `git commit -m "feat: route store and config"`.

### Task 2: HTTP API роутера и SSE-хаб

**Files:**
- Create: `src/router/hub.ts`, `src/router/api.ts`
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: `RouteStore`, `Route`, `guestLabel` (задача 1).
- Produces:
  ```ts
  type SessionEvent =
    | { type: 'message'; content: string; meta: Record<string, string> }
    | { type: 'permission'; request_id: string; behavior: 'allow' | 'deny' }
  class Hub {
    attach(sessionId: string, res: ServerResponse): void   // SSE, событие `data: <json>\n\n`, ping каждые 25 с
    send(sessionId: string, ev: SessionEvent): boolean      // false если подписки нет
    connected(sessionId: string): boolean
    onDetach(cb: (sessionId: string) => void): void
  }
  interface Outbound {                                       // реализует задача 3
    sendText(userId: string, text: string, replyTo?: string): Promise<string[]>
    sendFiles(userId: string, files: string[]): Promise<string[]>
    editText(userId: string, messageId: string, text: string): Promise<void>
    askPermission(userId: string, sessionId: string, req: PermissionRequest): Promise<void>
    notifyAdmin(text: string): Promise<void>
    botUsername(): string
  }
  interface PermissionRequest { request_id: string; tool_name: string; description: string; input_preview: string }
  function createApi(deps: { store: RouteStore; hub: Hub; out: Outbound; token: string; lostGraceMs: number; now?: () => number }): http.Server
  ```
  Маршруты API (все с Bearer, иначе 401):
  - `GET /health` → `{ ok: true, botUsername }`
  - `POST /routes` (тело `RouteInput`) → 201 `{ route, moved? }`; при `moved`: `hub.send(moved, { type: 'message', content: 'Гость перешёл в другую сессию и сюда больше не пишет.', meta: { kind: 'moved' } })` и `notifyAdmin` текстом "перенос".
  - `DELETE /routes/:sessionId` → `closed`, 200 `{ route }`; 404 если нет.
  - `GET /routes` → `{ routes }`.
  - `GET /sessions/:sessionId/events` → SSE; 404 если маршрута нет или он `closed`; при подключении `pending|lost → active`.
  - `POST /sessions/:sessionId/reply` `{ text: string; files?: string[]; reply_to?: string }` → `{ message_ids }`; 409 `{ error: 'гость ещё не писал боту' }`, если у маршрута нет `tgUserId`; 404/410 для отсутствующего/закрытого.
  - `POST /sessions/:sessionId/edit` `{ message_id, text }` → 200.
  - `POST /sessions/:sessionId/permission` (тело `PermissionRequest`) → 202, вызывает `out.askPermission`.
  - Отключение подписки active-маршрута: таймер `lostGraceMs`; не переподключился → `lost` + `notifyAdmin` текстом "обрыв". При старте роутера active-маршруты без подписки получают тот же таймер.

- [ ] **Step 1: Write the failing tests** `test/api.test.ts` (сервер на порту 0, `Outbound` - фейк, записывающий вызовы):
  - `rejects without bearer` - 401 на любой путь.
  - `events activates pending route` - после подключения к SSE `store.get(id).status === 'active'`.
  - `events 404 for unknown or closed`.
  - `disconnect then grace marks lost and notifies admin` - `lostGraceMs: 50`, закрыть SSE, через 100 мс `status === 'lost'`, у фейка `notifyAdmin` с текстом, содержащим `прервалась без stop`.
  - `reconnect within grace keeps active` - переподключение за 10 мс, уведомления нет.
  - `restart: active route without subscriber goes lost after grace` - store с active-маршрутом, `createApi` без подписки → через грейс `lost`.
  - `reply 409 before guest wrote`, `reply sends to tgUserId` (фейк получил `sendText('42', ...)`).
  - `post routes moves and notifies old session` - старая сессия подписана, получает событие `kind: 'moved'`.
- [ ] **Step 2: Run** `npx vitest run test/api.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement** `src/router/hub.ts` и `src/router/api.ts` на `node:http` без фреймворка; валидация тел через zod; сравнение токена `timingSafeEqual`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` - Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat: router api and sse hub"` (добавить новые файлы).

### Task 3: Telegram-сторона роутера

**Files:**
- Create: `src/router/telegram.ts`, `src/router/chunk.ts`
- Test: `test/telegram.test.ts`, `test/chunk.test.ts`

**Interfaces:**
- Consumes: `RouteStore`, `Hub`, `SessionEvent`, `Outbound`, `PermissionRequest` (задачи 1-2), `MediaHandler` (задача 4, на этом шаге - заглушка-интерфейс).
- Produces:
  ```ts
  function chunk(text: string, limit?: number): string[]      // limit 4096, режет по последнему \n в окне, иначе по limit
  interface BotLike { api: { sendMessage(chatId: string, text: string, opts?: object): Promise<{ message_id: number }>; editMessageText(...a: unknown[]): Promise<unknown>; sendDocument(...a: unknown[]): Promise<{ message_id: number }>; sendPhoto(...a: unknown[]): Promise<{ message_id: number }>; sendChatAction(chatId: string, a: 'typing'): Promise<unknown>; getMe(): Promise<{ username: string }> } }
  interface MediaHandler { toEvent(msg: IncomingMessage, sessionId: string): Promise<{ content: string; meta: Record<string, string> } | undefined> }
  function createTelegram(deps: { bot: BotLike; store: RouteStore; hub: Hub; media: MediaHandler; adminUserId: string; now?: () => number }): Outbound & {
    onMessage(msg: IncomingMessage): Promise<void>          // msg из grammy ctx.message
    onCallback(q: { id: string; from: { id: number }; data: string }, answer: (text?: string) => Promise<void>): Promise<void>
  }
  ```
  Поведение `onMessage`:
  1. `chat.type !== 'private'` → ничего (без ответа).
  2. `matchSender` → нет маршрута или `closed` → `Для вас сейчас нет активной сессии.`; `pending` → `Сессия запускается, напишите через минуту.`; `lost` → `Сессия прервалась, Стас в курсе.`
  3. Текст `/stop` → `setStatus(closed)`, гостю `Сессия завершена.`, в сессию `{ type: 'message', content: 'Гость завершил сессию командой /stop.', meta: { kind: 'stop' } }`.
  4. Текст по `/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i` при открытом запросе этого маршрута → `{ type: 'permission', ... }` вместо сообщения.
  5. Иначе: событие `{ type: 'message', content, meta: { chat_id, message_id, user, user_id, ts, kind: 'guest' } }` (+ поля от `media`), `touch`, индикатор набора; `hub.send` вернул false → гостю `Сессия прервалась, Стас в курсе.`
  `askPermission`: кнопки `perm:allow:<id>`, `perm:deny:<id>`, `perm:more:<id>`; текст `Подтвердить: <tool_name> - <description>`; запрос хранится в памяти `request_id → { sessionId, userId, req }`. `onCallback`: нажал не `userId` запроса → `Not authorized.`; запроса нет → `Запрос устарел.`; `more` → показать `input_preview` (обрезать до 3500); allow/deny → событие в сессию, кнопки убрать, запрос удалить.

- [ ] **Step 1: Write the failing tests:**
  - `test/chunk.test.ts`: `short text one chunk`; `splits at newline before limit` (`chunk('a'.repeat(10)+'\n'+'b'.repeat(10), 15)` → `['a'.repeat(10), 'b'.repeat(10)]`); `hard split without newline`; `every chunk <= 4096` на тексте 10000 символов с `*_[]` внутри.
  - `test/telegram.test.ts` (фейковый бот и хаб):
    - `group message ignored` - ни `sendMessage`, ни `hub.send`.
    - `stranger gets no-session text` - точный текст `Для вас сейчас нет активной сессии.`.
    - `pending and lost texts`.
    - `guest message reaches session with meta` - `meta.user_id === '42'`, `meta.kind === 'guest'`.
    - `stop closes route and notifies session` - `kind: 'stop'`, гостю `Сессия завершена.`.
    - `yes <id> becomes verdict` - после `askPermission`, текст `yes abcde` → `{ type: 'permission', request_id: 'abcde', behavior: 'allow' }`, сообщение в сессию не уходит.
    - `foreign button press rejected` - `from.id` другой → `answer('Not authorized.')`, `hub.send` не вызван.
    - `stale request rejected` - неизвестный id → `Запрос устарел.`.
    - `notifyAdmin sends to adminUserId`.
- [ ] **Step 2: Run** `npx vitest run test/chunk.test.ts test/telegram.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement** `src/router/chunk.ts`, `src/router/telegram.ts` (отправка без `parse_mode`; файлы: картинки `.jpg/.png/.gif/.webp` через `sendPhoto`, остальное `sendDocument`, до 50 МБ - больше отклонять ошибкой с именем файла).
- [ ] **Step 4: Run** `npm test && npm run typecheck` - Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: telegram side: gate, texts, chunking, permission buttons"`.

### Task 4: Голос и файлы

**Files:**
- Create: `src/router/media.ts`
- Test: `test/media.test.ts`

**Interfaces:**
- Consumes: `MediaHandler` (задача 3), `Config` (задача 1).
- Produces: `function createMedia(deps: { download: (fileId: string) => Promise<{ data: Buffer; name: string; mime?: string }>; inboxDir: (sessionId: string) => string; deepgram?: { key: string; language: string; model?: string }; fetch?: typeof fetch }): MediaHandler`
  - фото (наибольший размер) и документ → файл в `inbox/<sessionId>/<ts>-<имя>`, `meta.file_path`, `meta.file_name`, `meta.file_mime`; `content` - подпись сообщения или пусто.
  - голос / аудио / кружок (`voice`, `audio`, `video_note`) → файл в inbox и `meta.audio_path`; при наличии ключа Deepgram - `content: '[голосовое, расшифровка] <текст>'`; ключа нет или ошибка → `content: '[голосовое, расшифровать не удалось]'`, `meta.stt_error` с причиной.
  - Telegram отдаёт ботам файлы до 20 МБ: больше → `content: '[файл больше 20 МБ, попросите прислать ссылкой]'`.
  - Запрос к Deepgram - prerecorded `POST https://api.deepgram.com/v1/listen` с телом-аудио, параметры языка и модели - по скиллу `deepgram:api`; текст из `results.channels[0].alternatives[0].transcript`.

- [ ] **Step 1: Write the failing tests** (`download` и `fetch` - фейки):
  - `photo saved to inbox` - путь внутри `inboxDir(id)`, файл существует, `meta.file_path` указывает на него.
  - `voice transcribed` - фейковый fetch возвращает transcript `привет` → `content === '[голосовое, расшифровка] привет'`, запрос ушёл с `Authorization: Token <key>`.
  - `voice without key` - `content === '[голосовое, расшифровать не удалось]'`, fetch не вызван.
  - `deepgram error keeps audio path`.
  - `file over 20mb not downloaded`.
- [ ] **Step 2: Run** `npx vitest run test/media.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement** `src/router/media.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` - Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: voice via deepgram, files to session inbox"`.

### Task 5: Точка входа роутера, простой, systemd

**Files:**
- Create: `src/router/main.ts`, `src/router/idle.ts`, `deploy/telegram-delegate.service`, `deploy/install.sh`
- Modify: `README.md` (запуск, файлы, кто что вписывает)
- Test: `test/idle.test.ts`

**Interfaces:**
- Consumes: всё из задач 1-4.
- Produces: `function checkIdle(store: RouteStore, out: Outbound, now: number, idleHours: number): Promise<number>` - шлёт админу текст "простой" по каждому кандидату, отмечает, возвращает число.
  `main.ts`: `loadConfig` → без `botToken` выход с кодом 1 и сообщением `TELEGRAM_BOT_TOKEN не задан в ~/.config/telegram-delegate/.env`; `ensureApiToken`; grammy `Bot` long polling (`allowed_updates: ['message', 'callback_query']`); `createTelegram` + `createMedia` + `createApi`; `checkIdle` раз в 10 мин; SIGTERM - остановить бот и сервер.
  `deploy/telegram-delegate.service` - systemd **user** unit: `ExecStart=/usr/bin/env node %h/projects/js/telegram-delegate/src/router/main.ts`, `Restart=on-failure`, `RestartSec=5`. `install.sh` - копирует unit в `~/.config/systemd/user/`, `systemctl --user daemon-reload`, создаёт каталоги конфига/состояния и шаблон `config.json` (если нет), **не** создаёт `.env` с секретами - печатает, что вписать Стасу.

- [ ] **Step 1: Write the failing test** `test/idle.test.ts`: `notifies once per idle route` - active-маршрут с `lastMessageAt` 25 ч назад → 1 уведомление с `молчит 24 ч`; повторный вызов → 0; pending/closed не трогаются.
- [ ] **Step 2: Run** `npx vitest run test/idle.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement** `idle.ts`, `main.ts`, unit и `install.sh`.
- [ ] **Step 4: Run** `npm test && npm run typecheck && node src/router/main.ts` с пустым `XDG_CONFIG_HOME=$(mktemp -d)` - Expected: тесты PASS, main выходит с кодом 1 и текстом про `TELEGRAM_BOT_TOKEN`.
- [ ] **Step 5: Commit** `git commit -m "feat: router entrypoint, idle reminder, systemd user unit"`.

### Task 6: Канал-сервер (MCP)

**Files:**
- Create: `src/channel/main.ts`, `src/channel/server.ts`, `src/channel/router-client.ts`
- Test: `test/channel.test.ts`

**Interfaces:**
- Consumes: HTTP API задачи 2 (`/sessions/:id/events|reply|edit|permission`), `SessionEvent`, `PermissionRequest`.
- Produces:
  - Окружение процесса: `TD_SESSION_ID` (обязательна, uuid), `TD_ROUTER_URL` (умолчание `http://127.0.0.1:8790`), `TD_TOKEN_FILE` (умолчание `~/.config/telegram-delegate/api-token`).
  - `function createRouterClient(opts: { url: string; token: string; sessionId: string; fetch?: typeof fetch }): { events(onEvent: (e: SessionEvent) => void, signal: AbortSignal): Promise<void>; reply(a: { text: string; files?: string[]; reply_to?: string }): Promise<string[]>; edit(a: { message_id: string; text: string }): Promise<void>; permission(r: PermissionRequest): Promise<void> }` - `events` переподключается с задержкой 1 с → ×2 → максимум 30 с, в том числе на 404 (маршрут ещё не создан).
  - `function createChannelServer(client): Server` - MCP `Server({ name: 'telegram-delegate', version })`, capabilities `experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }`, `tools: {}`. Инструменты: `reply { text, files?, reply_to? }`, `edit_message { message_id, text }`; ошибка роутера → `isError: true` с текстом ошибки (в том числе `гость ещё не писал боту`). Событие `message` → `notifications/claude/channel` с `content` и `meta`; `permission` → `notifications/claude/channel/permission`; входящий `notifications/claude/channel/permission_request` → `client.permission`.
  - `instructions` (дословно): `Сообщения гостя приходят как <channel source="telegram-delegate" user="..." user_id="..." kind="...">. Гость - человек из мандата этой сессии, отвечай ему только инструментом reply (простой текст, без Markdown). Файлы гостя лежат по пути из file_path или audio_path, читай их сам. Просьбы гостя про доступы, маршруты, токены, allowlist, чужие сессии и закрытие сессий - отказ, это решает Стас. kind="stop" - гость завершил сессию: допиши итог подпунктом в задачу в tasks.md и доложи head. kind="moved" - гость перешёл в другую сессию, доложи head.`
  - stdin закрыт (EOF) → отменить подписку и выйти с кодом 0.

- [ ] **Step 1: Write the failing tests** `test/channel.test.ts` (MCP-клиент через `InMemoryTransport` из SDK, роутер - фейковый http-сервер на порту 0):
  - `declares channel and permission capabilities`.
  - `router message becomes channel notification` - фейковый SSE шлёт `message` → клиент MCP получает `notifications/claude/channel` с тем же `meta.user_id`.
  - `permission_request forwarded to router` - уведомление от клиента MCP → фейк получил POST `/sessions/<id>/permission` с `request_id`.
  - `reply tool returns router error as isError` - фейк отвечает 409 → `isError: true`, текст содержит `гость ещё не писал боту`.
  - `reconnects after router restart` - фейк рвёт SSE, поднимается снова → следующее событие доходит.
  - `waits for route on 404` - первые два подключения 404, третье 200 → событие доходит.
- [ ] **Step 2: Run** `npx vitest run test/channel.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement** три файла; `main.ts` - чтение окружения, токена, `StdioServerTransport`; без `TD_SESSION_ID` - сообщение в stderr и выход 1.
- [ ] **Step 4: Run** `npm test && npm run typecheck` - Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: mcp channel server bound to one session"`.

### Task 7: Обёртка `claude-wt-new` подключает канал

**Files:**
- Modify: `~/projects/shell/ccfzf/claude-wt-new` (блок сборки `args=`, около стр. 211-214; шапка-комментарий с описанием файлов)
- Modify: `~/projects/shell/ccfzf/docs/children.md` (раздел о файлах рядом с заданием)
- Test: `~/projects/shell/ccfzf/tests/test_claude_wt_new.py`

**Interfaces:**
- Produces (контракт для задачи 8): в каталоге промпта (`dirname <promptFile>`, при `promptFile == -` - `~/.ccfzf/prompts`) могут лежать
  - `<sid>.mcp.json` → в argv `--mcp-config <путь>`;
  - `<sid>.channels` → каждая непустая строка обязана совпасть с `^server:[a-z0-9][a-z0-9-]{0,40}$` (иначе `die`, exit 2, claude не запускается) → в argv `--dangerously-load-development-channels <строка>...`.
  - Порядок argv: `-n name --session-id sid [--permission-mode m] [--mcp-config f] [--dangerously-load-development-channels s...] [-- prompt]`.

- [ ] **Step 1: Write the failing tests** в `tests/test_claude_wt_new.py` (существующий фейковый claude записывает argv):
  - `test_mcp_config_and_channels_are_passed` - положить `<sid>.mcp.json` и `<sid>.channels` (`server:telegram-delegate`) рядом с промптом → argv содержит `--mcp-config <путь>` и `--dangerously-load-development-channels server:telegram-delegate` перед `--`, промпт последним.
  - `test_bad_channel_line_starts_nothing` - строка `server:x; rm -rf ~` → exit 2, фейковый claude не вызван.
  - `test_no_side_files_no_flags` - argv без этих флагов (регрессия).
- [ ] **Step 2: Run** `python3 -m pytest tests/test_claude_wt_new.py -q` - Expected: FAIL на новых тестах.
- [ ] **Step 3: Implement** в `claude-wt-new`.
- [ ] **Step 4: Run** `python3 -m pytest tests -q` - Expected: PASS весь набор.
- [ ] **Step 5: Commit** по правилам репо ccfzf (conventional commit, `feat(claude-wt-new): mcp config and dev channels from side files`). Вендор-копия в ccfzf-picker обновляется по правилам того репо - отдельным шагом его исполнителя, если нужно.

### Task 8: `spawn.mjs` - id сессии, MCP-конфиг и каналы

**Files:**
- Modify: `~/.claude/skills/session-spawn/spawn.mjs` (разбор флагов; блок `sessionId = randomUUID()`; запись файлов и `dropCopies`; dry-run вывод)
- Modify: `~/.claude/skills/session-spawn/SKILL.md` (таблица "Что скрипт решает сам" и флаги)
- Test: `~/.claude/skills/test/spawn.test.mjs`

**Interfaces:**
- Consumes: контракт файлов задачи 7.
- Produces: новые флаги `spawn.mjs`
  - `--session-id <uuid>` - вместо `randomUUID()`; не uuid → `fail`.
  - `--mcp-config <file>` - файл обязан существовать и парситься как JSON → копия в `~/.ccfzf/prompts/<sid>.mcp.json` (0600).
  - `--dev-channels <список через запятую>` - каждый элемент по тому же regex, что в задаче 7 → `~/.ccfzf/prompts/<sid>.channels` (по строке на элемент, 0600).
  - Dry-run печатает `sessionId`, `mcpConfig`, `devChannels`. При отказе менеджера оба файла удаляются вместе с остальными (`dropCopies`); session-close удаляет их так же, как `<sid>.md` (проверить и дописать, если нет).

- [ ] **Step 1: Write the failing tests** в `test/spawn.test.mjs` (существующий harness с мок-менеджером):
  - `session-id flag is used` - тело запроса содержит переданный uuid.
  - `bad session-id fails`.
  - `mcp-config and dev-channels written next to prompt` - оба файла существуют, права 600, `.channels` = `server:telegram-delegate\n`.
  - `bad dev-channel fails before request` - мок не получил запроса.
  - `side files removed on refusal` - мок отвечает 403 → файлов нет.
- [ ] **Step 2: Run** `node --test test/spawn.test.mjs` (из `~/.claude/skills`) - Expected: FAIL на новых.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test test/` - Expected: PASS весь набор.
- [ ] **Step 5: Commit** `git commit -m "spawn: --session-id, --mcp-config, --dev-channels"`.

### Task 9: Скилл `telegram-delegate`

**Files:**
- Create: `~/.claude/skills/telegram-delegate/SKILL.md`, `~/.claude/skills/telegram-delegate/delegate.mjs`
- Test: `~/.claude/skills/test/telegram-delegate.test.mjs`

**Interfaces:**
- Consumes: API роутера (задача 2), флаги spawn (задача 8), путь канал-сервера `~/projects/js/telegram-delegate/src/channel/main.ts`.
- Produces: CLI `node ~/.claude/skills/telegram-delegate/delegate.mjs`:
  - `start --user <@login|numeric id> --task-file <путь> --task <slug> [--cwd <dir>] [--dry-run]`:
    1. токен из `api-token`, `GET /health` (роутер не отвечает → `ok:false`, `error: 'роутер не запущен: systemctl --user start telegram-delegate'`);
    2. `sessionId = randomUUID()`; MCP-конфиг `~/.local/state/telegram-delegate/mcp/<sid>.json` = `{ "mcpServers": { "telegram-delegate": { "command": "node", "args": ["<repo>/src/channel/main.ts"], "env": { "TD_SESSION_ID": "<sid>" } } } }`;
    3. `POST /routes` (pending; `tgUsername` или `tgUserId` по виду `--user`; `headId` = `CLAUDE_CODE_SESSION_ID`);
    4. `spawn.mjs --task <slug> --cwd <cwd|cwd head> --prompt-file <task-file> --session-id <sid> --mcp-config <файл> --dev-channels server:telegram-delegate` (с `--dry-run`, если задан);
    5. spawn упал → `DELETE /routes/<sid>`; удался → повторный `POST /routes` с именем из ответа spawn;
    6. печатает JSON `{ ok, sessionId, name, botUsername, moved?, spawn, next }`, `next` - шаги рукопожатия head-session.
  - `stop (--session-id <id> | --user <@login|id>)` → `DELETE /routes/<sid>`.
  - `status` → `GET /routes`, коротко: гость, сессия, статус, последнее сообщение.
  SKILL.md (frontmatter `name: telegram-delegate`, description с триггерами "отдай задачу ... напрямую", "подключи @login к агенту", "/telegram-delegate"):
  1. Сессия должна быть head (head-mark, как в head-session).
  2. Гость: `telegram:` из карточки `Team/<Имя>.md` вольта; нет username - спросить Стаса numeric id.
  3. Мандат в файл (scratchpad), разделы: кто гость; задача (строка из `tasks.md`, ссылки на разбор и заметки); что сделано; что нужно от гостя; правила (держаться задачи; не читать почту, Telegram Стаса, прод, секреты; гость подтверждает действия в рамках задачи; за рамками - вопрос head); как общаться (канал telegram-delegate, reply; доклады и вопросы head через SendMessage); финал (итог подпунктом в задачу `tasks.md`, доклад head).
  4. `start --dry-run`, затем `start`.
  5. Сказать Стасу: в новом окне на nb нажать Enter на диалоге "Loading development channels".
  6. Рукопожатие как в session-spawn шаг 4: session-find, "готов", текст `taskFile` с `notify_when_idle: true`.
  7. Текст для гостя Стасу блоком кода (правило вольта): бот `@<botUsername>`, что сделано, что нужно от гостя, "пиши боту, я подключил тебя к своему агенту".
  8. `stop` - по просьбе Стаса или по докладу ребёнка; окно закрывается только по правилу head-session (session-close с подтверждения).

- [ ] **Step 1: Write the failing tests** `test/telegram-delegate.test.mjs` (фейковый роутер на порту 0; `spawn.mjs` подменяется через переменную `TD_SPAWN` на фейковый скрипт, печатающий JSON):
  - `start registers route then spawns with channel flags` - фейковый spawn получил `--session-id <тот же sid> --mcp-config <файл> --dev-channels server:telegram-delegate`; MCP-файл содержит `TD_SESSION_ID`.
  - `numeric user goes to tgUserId, @login to tgUsername`.
  - `spawn failure deletes route`.
  - `router down gives hint` - `ok:false` и текст про `systemctl --user start telegram-delegate`.
  - `stop by user deletes its route`.
- [ ] **Step 2: Run** `node --test test/telegram-delegate.test.mjs` - Expected: FAIL.
- [ ] **Step 3: Implement** `delegate.mjs` и `SKILL.md`.
- [ ] **Step 4: Run** `node --test test/` - Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "telegram-delegate: skill and delegate.mjs"`.

### Task 10: Выкатка и живая проверка (head + Стас)

**Files:** нет нового кода; итог - в заметку дизайна (раздел "Проверено") и подпунктом в задачу `tasks.md`.

- [ ] **Step 1: Стас** создаёт бота в BotFather, вписывает `TELEGRAM_BOT_TOKEN` и `DEEPGRAM_API_KEY` в `~/.config/telegram-delegate/.env`.
- [ ] **Step 2:** `deploy/install.sh`, `systemctl --user enable --now telegram-delegate`, `journalctl --user -u telegram-delegate -n 20` - Expected: строка о старте поллинга с именем бота. Windows не трогается: выкатка на nb не нужна, все правки на pc-virt.
- [ ] **Step 3:** Проверить, что `--mcp-config` не вызывает диалог согласия: `/telegram-delegate` на себя (гость = второй аккаунт Стаса или numeric id Стаса как гостя) с тестовой задачей; в окне на nb один диалог dev-каналов, Enter, затем баннер `Channels (experimental) messages from server:telegram-delegate ...`.
- [ ] **Step 4:** Сценарии вживую, каждое - отметка в разделе "Проверено":
  - текст гостя доходит, ответ приходит; длинный ответ режется;
  - голосовое расшифровывается; фото и PDF агент читает;
  - кнопка подтверждения у гостя срабатывает, у постороннего - `Not authorized.`;
  - посторонний аккаунт получает `Для вас сейчас нет активной сессии.`;
  - `/stop` гостя - агент пишет итог в задачу и докладывает head;
  - закрытие окна без stop - админу `прервалась без stop`, гостю `Сессия прервалась, Стас в курсе.`;
  - перезапуск роутера (`systemctl --user restart`) при живой сессии - разговор продолжается.
- [ ] **Step 5:** Первый боевой прогон - задача Саши с конкурсами, по решению Стаса.
