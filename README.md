# telegram-delegate

Let someone talk to a [Claude Code](https://claude.com/claude-code) session directly in Telegram.

You start a Claude Code session for a task and hand it to a person (the "guest"). The guest writes to your Telegram bot in a private chat; their messages, files and voice messages arrive in that session, and the agent answers them in Telegram. Each session is bound to one guest: everyone else gets "There is no active session for you right now."

It is built on Claude Code Channels and has two parts:

- **Router** (`src/router/`) - a long-running process (systemd user service). It owns the bot (long polling), keeps routes "guest -> sessionId" and serves an HTTP API on `127.0.0.1:8790` only.
- **Channel server** (`src/channel/`) - a stdio MCP server that Claude Code starts inside the delegated session. It subscribes to the router (SSE) for the guest's messages and gives the agent the `reply` and `edit_message` tools.

```
guest <-> Telegram <-> router (bot + 127.0.0.1 API) <-SSE/HTTP-> channel server (MCP, stdio) <-> Claude Code session
```

What the router does besides routing:

- Files and photos from the guest are saved to the session's inbox; the agent gets the path. Voice, audio and video notes are transcribed with [Deepgram](https://deepgram.com) when `DEEPGRAM_API_KEY` is set.
- Tool permission prompts of the session (`claude/channel/permission`) go to the guest as Allow / Deny buttons. Only the route's guest can press them.
- The agent can attach answer options as buttons under a reply; a press comes back to the session as a message.
- `/stop` from the guest closes the route and tells the session.
- The bot owner (`adminUserId`) gets a notice when a session drops without `/stop`, when a guest is silent for `idleHours` and when a guest's route moves to another session.
- The log (journalctl) has one line per routing decision, without the guest's texts, captions or file names.

## Requirements

- Node.js 24+ (TypeScript runs directly through type stripping, no build step).
- Claude Code with channels support (`--dangerously-load-development-channels`).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- Optional: a Deepgram API key for voice messages.
- Linux with systemd for the service (the router itself is a plain `node` process).

## Install the router

```bash
git clone <this repo> telegram-delegate
cd telegram-delegate
npm install
deploy/install.sh
```

`deploy/install.sh` installs the user unit to `~/.config/systemd/user/telegram-delegate.service` (with the absolute paths of this checkout and of `node`; set `NODE=/path/to/node` to choose another binary, re-run after moving the checkout or switching Node), creates the config and state dirs and a `config.json` template. It does not create the secrets file and does not start the service.

Then:

1. Put your numeric Telegram user id into `adminUserId` in `~/.config/telegram-delegate/config.json` (for example, [@userinfobot](https://t.me/userinfobot) tells it). The router refuses to start without it.
2. Create `~/.config/telegram-delegate/.env` with mode 600:

   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   DEEPGRAM_API_KEY=...        # optional
   ```

3. Start it and check the log:

   ```bash
   systemctl --user enable --now telegram-delegate
   journalctl --user -u telegram-delegate -n 20   # "config ok language=en port=8790", "polling as @your_bot"
   ```

To keep the service running after logout: `loginctl enable-linger $USER`.

The router exits with code 1 on a bad `config.json`, without `TELEGRAM_BOT_TOKEN` or when Telegram rejects the token. Real environment variables override `.env`.

## Quick start

With the router running, install the command from the checkout and start a session for a guest:

```bash
npm link                     # or: npm install -g .   (puts telegram-delegate on PATH)
telegram-delegate start --user @guest_username --task-file task.md
```

`start` creates the route, writes the session's MCP config to `~/.local/state/telegram-delegate/mcp/<sessionId>.json` and runs Claude Code in this terminal:

```
claude --session-id <uuid> -n <name> --mcp-config <file> --dangerously-load-development-channels server:telegram-delegate -- <task>
```

Claude Code warns about loading development channels: press Enter. The text of `--task-file` becomes the first prompt; without it, paste the task yourself. Tell the agent who the guest is, what to do with them, what is out of scope and what to do on `/stop`. The guest should open the bot and press Start: until the bot knows their id it cannot write to them.

When Claude Code exits (including Ctrl+C or a SIGTERM/SIGHUP to the command), `start` closes the route, so the owner gets no "session ended" notice. The exit code is Claude Code's.

```
telegram-delegate start --user <@username|id> [--task-file <file>] [--name <name>] [--write-first | --no-write-first] [--dry-run]
telegram-delegate stop (--user <@username|id> | --session-id <uuid>)
telegram-delegate status [--all]
```

- `--name` - session name and route name, default `telegram-delegate-<username|id>`.
- `--write-first` / `--no-write-first` - override `writeFirst` from the router config. When it is on and the bot knows the guest's id, the prompt gets a section telling the agent to write to the guest first; on a Telegram 403 the agent tells you in the terminal instead of retrying.
- `--dry-run` - print the `POST /routes` body, the MCP config and the claude command line; nothing is created.
- If the guest already had an open route to another session, `start` warns: the route moves to the new session and the old one is told.
- `stop` closes the route (Claude Code keeps running, the guest gets "no session"); `status` lists open routes, `--all` with closed ones.
- Env: `TD_ROUTER_URL` (default `http://127.0.0.1:<port from config.json>`), `TD_TOKEN_FILE`, `TD_CLAUDE` (claude binary, default `claude` from PATH).

The session runs with your permissions in the current directory; the guest only approves the tool calls Claude Code asks about. Start it in a directory and permission mode you are comfortable with.

## Configuration

`~/.config/telegram-delegate/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `adminUserId` | required | Numeric Telegram id of the bot owner; admin notices go there. |
| `language` | `"en"` | Language of the bot texts for the guest and the owner: `"en"` or `"ru"`. Anything else is a startup error. |
| `port` | `8790` | API port, always on `127.0.0.1`. |
| `idleHours` | `24` | Notify the owner once when an active guest has been silent this long. |
| `lostGraceSec` | `60` | How long the router waits for a dropped channel server to reconnect before it marks the route `lost`. |
| `writeFirst` | `false` | Whether the agent should write to the guest first. The router only reports it (see `POST /routes`); the bot can write first only to a guest whose numeric id it knows. |
| `deepgram.language` | value of `language` | Deepgram transcription language, for example `"en"`, `"ru"`, `"multi"`. |
| `deepgram.model` | `"nova-3"` | Deepgram model. |

Texts the agent reads (channel server instructions, tool descriptions, API errors) are always in English.

Files:

| Path | Written by | Contents |
|---|---|---|
| `~/.config/telegram-delegate/.env` | you | `TELEGRAM_BOT_TOKEN`, `DEEPGRAM_API_KEY` |
| `~/.config/telegram-delegate/config.json` | `install.sh` (template), you | the keys above |
| `~/.config/telegram-delegate/api-token` | router on first start (mode 600) | Bearer token of the local API |
| `~/.local/state/telegram-delegate/routes.json` | router | routes |
| `~/.local/state/telegram-delegate/known.json` | router | who wrote to the bot in private: username, numeric id, last message time (no texts) |
| `~/.local/state/telegram-delegate/inbox/<sessionId>/` | router | guest files and voice messages |

Paths follow `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.

## Router API

`http://127.0.0.1:8790`, every request needs `Authorization: Bearer <api-token>`.

| Method and path | What it does |
|---|---|
| `GET /health` | `{ ok, botUsername }` |
| `GET /routes` | `{ routes }` |
| `POST /routes` | Body `{ sessionId, sessionName, headId, tgUsername?, tgUserId? }`, one of `tgUsername` / `tgUserId` is required. Creates or updates the route in status `pending` and answers 201 `{ route, moved?, canWriteFirst, writeFirst }`. A route by username gets the numeric id from `known.json` when the guest has written to the bot before. `canWriteFirst` - the id is known; `writeFirst` = `config.writeFirst && canWriteFirst`. If the same guest had another open route, it is moved: `moved` is the old route, its session and the owner are told. |
| `GET /known?tgUsername=` or `?tgUserId=` | `{ known, tgUserId?, canWriteFirst, writeFirst }` without creating a route. |
| `DELETE /routes/:sessionId` | Closes the route. |
| `GET /sessions/:id/events` | SSE stream for the channel server; connecting makes the route `active`. |
| `POST /sessions/:id/reply` | `{ text, files?, reply_to?, buttons? }` -> `{ message_ids }`. 409 while the bot does not know the guest's id yet. `buttons`: up to 8 options, up to 64 characters each, needs `text`. |
| `POST /sessions/:id/edit` | `{ message_id, text }` |
| `POST /sessions/:id/permission` | `{ request_id, tool_name, description, input_preview }` -> Allow / Deny buttons for the guest. |

`headId` is a free-form label of whoever delegated the session (it is stored, not interpreted); an empty string is fine.

Route statuses: `pending` (created, the session has not connected yet) -> `active` (channel server connected) -> `closed` (`/stop` from the guest or `DELETE`) or `lost` (the channel server dropped for longer than `lostGraceSec`). The guest of a `pending` or `lost` route gets a short notice instead of silence.

A Telegram 403 on reply (the guest never pressed Start or blocked the bot) comes back to the agent as an error starting with `Telegram 403:`.

## Channel server

Claude Code starts it from an MCP config. Environment:

| Variable | Default | |
|---|---|---|
| `TD_SESSION_ID` | required, uuid | Must equal the session id and the route's `sessionId`. |
| `TD_ROUTER_URL` | `http://127.0.0.1:8790` | |
| `TD_TOKEN_FILE` | `~/.config/telegram-delegate/api-token` | |

Agent tools:

- `reply { text, files?, reply_to?, buttons? }` - plain text, long text is split. `files` are absolute paths (images go as photos, the rest as documents, up to 50 MB; files from the router's own dirs are refused, except the session's inbox). `buttons` are answer options under the last chunk; a press arrives with `kind="button"` and the option text, the buttons are removed and the message shows the choice.
- `edit_message { message_id, text }` - edits a message sent earlier (no notification for the guest).

Incoming messages arrive as `<channel source="telegram-delegate" user="..." user_id="..." kind="...">` with `kind` = `guest`, `button`, `stop` (the guest sent `/stop`) or `moved` (the guest's route moved to another session). Files and voice messages add `file_path` / `audio_path`, `file_name`, `file_mime`.

Tool permission prompts of the session go to the guest as buttons; the guest can also answer `y <id>` / `n <id>` as text. When Claude Code closes stdin, the channel server exits; without `/stop` the router marks the route `lost` after `lostGraceSec` and tells the owner.

## Without the CLI

What `telegram-delegate start` does, by hand. You need the router running and the guest's Telegram username or numeric id. The guest should open the bot and press Start: until the bot knows their id it cannot write to them.

1. Pick a session id and create the route:

   ```bash
   SID=$(uuidgen | tr 'A-Z' 'a-z')
   TOKEN=$(cat ~/.config/telegram-delegate/api-token)
   curl -s -X POST http://127.0.0.1:8790/routes \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d "{\"sessionId\":\"$SID\",\"sessionName\":\"report-review\",\"headId\":\"\",\"tgUsername\":\"guest_username\"}"
   ```

   The answer has `canWriteFirst`: `false` means the bot has not seen this guest yet, so the agent has to wait for their first message.

2. Write an MCP config for this session (use the absolute path of your checkout):

   ```bash
   cat > /tmp/td-$SID.json <<EOF
   {
     "mcpServers": {
       "telegram-delegate": {
         "command": "node",
         "args": ["$PWD/src/channel/main.ts"],
         "env": { "TD_SESSION_ID": "$SID" }
       }
     }
   }
   EOF
   ```

3. Start Claude Code in the directory the task needs, with the same session id:

   ```bash
   claude --session-id "$SID" --mcp-config /tmp/td-$SID.json \
     --dangerously-load-development-channels server:telegram-delegate
   ```

4. Claude Code warns about loading development channels: press Enter to confirm.
5. Paste the task: who the guest is, what to do with them, what is out of scope, and what to do when the guest sends `/stop`. Tell the agent to answer the guest only with the `reply` tool. If `canWriteFirst` was `true` and you want the agent to start the conversation, say so.

The route becomes `active` when the channel server connects. Close it when you are done, also after Claude Code exits, otherwise the router marks it `lost` and notifies the owner: `curl -s -X DELETE -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8790/routes/$SID`.

## Development

```bash
npm install
npm test           # vitest, Telegram and Deepgram are fakes, no network
npm run typecheck
```

## License

[MIT](LICENSE)
