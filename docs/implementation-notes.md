# Решения исполнителя задач 1-6 и отложенное

Из ledger исполнения плана (executing-plans), 17.11.2026. Ревью всей ветки - свежий ревьюер (opus): Critical 0, Important 4 (исправлены в ab71c24).

## Решения

- Pre-flight: T3 consumes IncomingMessage (не определён) -> Ruling: свой структурный тип src/router/types.ts (подмножество grammy Message) - grammy Message присваивается - если не так, правка типа.
- Pre-flight: T2/T3 notifyAdmin - кто ставит префикс -> Ruling: тексты с префиксом собирает src/texts.ts, notifyAdmin шлёт как есть - дешево поправить.
- Pre-flight: T6 createChannelServer(client): Server не говорит, кто запускает events -> Ruling: второй необязательный аргумент signal, подписка стартует в oninitialized - иначе уведомления до initialize.
- Task 1: Ruling: upsert закрывает любой не-closed маршрут того же гостя (pending/active/lost), не только active - иначе два открытых маршрута одного гостя и matchSender неоднозначен - стоит лишнего закрытия pending.
- Task 1: Ruling: idleCandidates считает от lastMessageAt ?? createdAt, touch сбрасывает idleNotifiedAt - спека "маршрут без сообщений N часов" - лишнее напоминание, если гость не писал.
- Task 1: Ruling: TS 7 (npm latest), @types/node@24; npm audit 5 high только в dev-цепочке vitest - не прод.
- Task 2: Ruling: SessionEvent/Outbound/PermissionRequest/IncomingMessage в src/router/types.ts, а не в api.ts/hub.ts - общие для задач 2-6 - только место импорта.
- Task 2: Ruling: reply/edit/permission: 404 нет маршрута, 410 closed, 409 нет tgUserId, 502 ошибка Telegram; POST /routes требует tgUsername или tgUserId (400) - спека: маршрут без гостя бессмыслен.
- Task 2: Ruling: DELETE /routes не рвёт SSE - канал-сервер просто получит 404 на переподключении - лишняя подписка до перезапуска.
- Task 3: Ruling: createTelegram возвращает ещё init() (getMe, кэш botUsername) - Outbound.botUsername() синхронный - main должен вызвать init.
- Task 3: Ruling: hub в deps как Pick<Hub,'send'> - для фейка в тесте - без поведения.
- Task 3: Ruling: кнопка от гостя по закрытому маршруту = "Запрос устарел."; hub.send false на вердикт = гостю "Сессия прервалась, Стас в курсе.", запрос остаётся; сообщение без текста и без медиа уходит в сессию с пометкой "[сообщение без текста, такой тип не поддерживается]" - анти-цель "пишет в пустоту".
- Task 3: Ruling: "yes <id>" перехватывается только при открытом запросе этого маршрута и этого userId, иначе обычное сообщение; /stop@botname тоже stop; is_bot игнорируется.
- Task 4: Ruling: Deepgram nova-3 (скилл deepgram:api: prerecorded /v1/listen, nova-3), language из конфига, smart_format+punctuate; пустая расшифровка = ошибка stt_error "пустая расшифровка"; video_note шлётся как video/mp4.
- Task 4: Ruling: при >20 МБ meta содержит file_name без file_path; имя на диске - только буквы/цифры/._- (до 120), в meta - safeName как в официальном плагине.
- Task 5: Ruling: install.sh понимает TD_NO_SYSTEMCTL=1 (без daemon-reload) - проверен в scratch HOME, реальный systemd не трогал - лишний флаг.
- Task 5: Ruling: main маскирует bot token в логах (scrub), 401 от Telegram = exit 1, прочие ошибки поллинга - ретрай с backoff до 15 с, как в официальном плагине.
- Task 6: Ruling: createChannelServer(client, { signal? }) - подписка стартует в oninitialized, abort по signal или server.onclose; createRouterClient принимает minDelayMs/maxDelayMs (умолчания 1 с/30 с) для быстрых тестов.
- Task 6: Ruling: ключи meta не из [A-Za-z0-9_] канал-сервер отбрасывает (протокол Channels); TD_TOKEN_FILE по умолчанию учитывает XDG_CONFIG_HOME.
- Final: Ruling: plan Task 3 step 5 ("hub.send false -> гостю Сессия прервалась") заменён очередью в хабе для active-маршрута без подписки - иначе рестарт роутера теряет сообщения и врёт гостю (Review Focus 3, задача 10 "разговор продолжается"); на lost очередь сбрасывается и гостю уходит "Сессия прервалась, Стас в курсе." - стоит: до lostGraceSec гость не получает ответа о проблеме.
- Final: Ruling: перенос маршрута при username-маршруте после id-маршрута обнаруживается в matchSender (первое сообщение гостя), RouteStore.onMoved - при upsert сравнить нечем - стоит: старая сессия узнаёт о переносе только когда гость напишет.
- Final: Ruling: minor -> fix по эффекту: кнопка по lost/closed маршруту = "Запрос устарел." (Focus 5); перепроверка маршрута после загрузки медиа (анти-цель "чужая сессия"); обрезка текста запроса подтверждения до 4096 (иначе гость без кнопок).

## Отложенные minor

- /stop не работает на pending/lost маршруте
- notifyAdmin 403, если Стас не нажал Start у нового бота - нет проверки на старте
- sessionId в API не валидируется как uuid (token-gated)
- lost -> active молча, Стасу нет "восстановилась"
- chunk может разрезать суррогатную пару и дать кусок из одних пробелов
- channel main без watchdog stdin.destroyed как в официальном плагине
- exit 1 при отсутствии/401 токена + Restart=on-failure = перезапуск каждые 5 с
- .env inline # комментарии остаются в значении; битый routes.json валит старт
- pending-запросы подтверждения без TTL
- /stop при отключённой подписке кладёт событие в очередь уже закрытого маршрута - не сольётся (events для closed = 404), сессия про stop не узнает

## Бот пишет первым (17.11)

- Ruling: canWriteFirst считается по итоговому `route.tgUserId` после upsert (id из запроса, из known.json или унаследованный от старого маршрута гостя) - спека head: "id известен (из запроса или из памяти)"; цена ошибки - ребёнок попробует написать по id из запроса человеку, не нажимавшему Start, и получит понятный 403.
- Ruling: `GET /known` - отдельный read-only запрос для `delegate.mjs --dry-run`, который не создаёт маршрут.
- Ruling: known.json пишется только из личных сообщений людей (группы и боты - нет); нажатия кнопок не пишутся - кнопки видит только тот, кому бот уже писал.
- Ruling: уведомление админу об обрыве - ровно "Сессия завершена" (решение Стаса 17.11), имя и id сессии - в строке журнала `admin lost <sessionId>`.
