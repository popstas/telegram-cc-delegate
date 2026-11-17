---
name: telegram-cc-delegate
description: Use when the user wants a colleague, client or friend to talk to a Claude Code agent directly in Telegram about a task instead of relaying messages by hand - "hand this task to @login", "let Anna talk to the agent herself", "connect @login to an agent", "delegate via Telegram" - and the telegram-cc-delegate router is installed.
---

# Hand a task to a Telegram guest

The router of [telegram-cc-delegate](https://github.com/popstas/telegram-cc-delegate) owns a Telegram bot. `telegram-cc-delegate start` binds one guest to a new Claude Code session and runs that session **in the terminal where the command is started**. Your job: prepare the task file, check it with `--dry-run`, and give the user the command to run. The guest then talks to the new session; you stay out of it.

## Steps

1. `telegram-cc-delegate status`. "router is not reachable" - tell the user the command from the error, stop. A route already open for this guest - say so: `start` will move the guest away from that session.
2. Guest: `@username` or numeric id **from the user**, in the same question - who the guest is to them and the form of address, if the conversation does not say. Do not guess any of it from a name or a handle, and do not take it from mail or chats.
3. Write the task file. The new session does not see this conversation: the file is everything it knows. Sections, in this order:
   1. **Guest** - name, @username, who they are to the user, "you" or formal address.
   2. **Task** - what to do, file paths, links.
   3. **Done so far** - facts and decisions the user already made.
   4. **What you need from the guest** - questions, materials, decisions.
   5. **Rules** - stay on the task; do not read the user's mail, chats, secrets or production data; the guest confirms actions inside the task; anything outside it - ask the user in the terminal.
   6. **How to talk** - guest messages arrive as `<channel source="telegram-delegate" ...>`; answer the guest only with the `reply` tool, plain text, `buttons` for choices; report to the user in the terminal.
   7. **Finish** - where to write the result; a message with `kind="stop"` from the guest means the same.

   Put it next to the work (for example `<project>/.delegate/<slug>.md`), not in a temp dir that may be cleaned before the user runs it.
4. `telegram-cc-delegate start --user <guest> --task-file <file> --name <slug> --dry-run`. Read `writeFirst`:
   - `true` - the session writes to the guest first.
   - `false` with `canWriteFirst: false` - the bot has never seen this guest. The guest must open the bot and press Start first, otherwise Telegram answers 403. The user sends them one line (step 6).
5. **Do not run `start` yourself.** It runs Claude Code in the foreground and waits for Enter on the "Loading development channels" warning; from your shell it hangs or breaks. Give the user:

   ```
   cd <the directory the task works in>
   telegram-cc-delegate start --user <guest> --task-file <file> --name <slug>
   ```

   and tell them: press Enter on the warning; the session works in that directory; closing Claude Code closes the route; `telegram-cc-delegate stop --user <guest>` closes it from elsewhere.
6. Text for the guest, in a code block, written as the user (their voice, their form of address): what the task is, what is needed from them, "write to @<botUsername> - text, voice or files, an agent will answer". Always give it, even with `writeFirst: true`: a first message from an unknown bot is easy to miss.
7. Permission mode. The session starts in the user's default mode. In auto mode the safety classifier can block `reply` to a stranger as unsanctioned communication. If the user works in auto mode and `mcp__telegram-delegate__reply` / `mcp__telegram-delegate__edit_message` are not in `permissions.allow` of `~/.claude/settings.json`, tell them to add both. Do not edit their settings yourself. In default mode tool permission prompts go to the guest as Allow/Deny buttons.

## Common mistakes

| Mistake | Do instead |
|---|---|
| Running `start` from your own shell | give the user the command for their terminal |
| Task file retells this conversation, with private context | only the task, its facts and the rules |
| Guest id guessed or looked up | ask the user |
| `canWriteFirst: false` ignored | guest presses Start first; user sends the line |
| Task file in `/tmp` | next to the work |
| No text for the guest because `writeFirst: true` | always give it |
| Editing `settings.json` to allow `reply` | tell the user which two rules to add |
