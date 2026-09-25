# Vogent chat CLI and Codex skill

This repository contains a dependency-free Node.js CLI for typed conversations with Vogent agents and a `SKILL.md` that guides Codex through using it. This public copy removes a project-specific staging shortcut, so every chat requires an explicit confirmation or `--allow-live`.

## Requirements and setup

- Node.js 22 or newer, with built-in `fetch` and `WebSocket`.
- A Vogent API key available as `VOGENT_API_KEY` or in an untracked `.env.local` file beside `chat.mjs` containing `VOGENT_API_KEY=...`.

Do not commit `.env.local` or include a key in command arguments. The CLI makes requests to `api.vogent.ai` and its GraphQL WebSocket endpoint.

To install the Codex skill, clone this repository into your skills directory:

```sh
git clone https://github.com/dustindog101/vogent-chat-cli.git ~/.codex/skills/vogent-chat
```

The repository root is the skill folder, so Codex can load `SKILL.md` and run the adjacent `chat.mjs`. You can also clone anywhere and run the CLI directly.

## Commands

```sh
node chat.mjs --help
node chat.mjs --list
node chat.mjs --agent 'Agent name or ID' --inspect
node chat.mjs --agent 'Agent name or ID'
node chat.mjs --agent 'Agent name or ID' --message 'Hello' --message 'What times are open?' --allow-live
```

`--list` and `--inspect` read account and agent configuration without creating a chat. `--inspect` prints the active prompt ID, flow node count, linked function targets, and phone linkage. Without `--agent`, an interactive menu lets you choose an agent. In an interactive chat, type the agent's name to confirm, enter messages, and use `/quit` to end.

Starting a chat creates a persisted Vogent chat record. A turn can invoke linked functions and change backend data; review the targets first and use synthetic data for write tests. For noninteractive chats, `--allow-live` is required. Set `VOGENT_CHAT_TIMEOUT_MS` to change the per-turn timeout (clamped to 5–180 seconds; default 45 seconds).

This tests typed conversation behavior. It does not test phone audio, speech recognition, interruptions, transfers, or hangup. The GraphQL chat operations were observed in Vogent's dashboard and are not a documented public API contract, so provider changes may require an update.

## Status

The CLI syntax and local startup paths are checked before release. A live chat requires a Vogent credential and is deliberately not part of this repository's public verification.
