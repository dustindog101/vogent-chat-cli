---
name: vogent-chat
description: Use the bundled Vogent text-chat CLI to inspect agents or test their typed conversations and linked functions. Applies to Vogent agent chat checks, not phone or audio tests.
---

# Vogent text chat

Use `chat.mjs` in this folder from a terminal with Node.js 22 or newer. Set `VOGENT_API_KEY` in the environment or in an ignored `.env.local` beside the script. Never put the key in a command argument, committed file, or test transcript.

Before a conversation, run `node chat.mjs --list`, then `node chat.mjs --agent ID --inspect`. The inspection reads the active prompt, flow node count, linked function targets, and phone linkage without creating a chat. Review the function targets and choose a suitable agent and test data before proceeding.

Run `node chat.mjs --agent ID` for an interactive chat. Type the selected agent's name at the confirmation prompt, then enter turns; `/quit` ends the session. For a scripted conversation, pass one `--message 'text'` per turn and `--allow-live` after reviewing the agent. Never infer permission for a live chat or backend write from a request to inspect an agent.

Each chat creates a persisted Vogent chat record; turns can invoke linked functions and change backend data. Record the chat ID, prompt ID, exact turns, responses, and any relevant backend effects. Use synthetic data when exercising write paths. A text chat does not validate speech recognition, audio, interruptions, transfer, or hangup.

The chat GraphQL operations were observed in Vogent's dashboard, not documented as a public API contract. If the CLI stops working, verify the current dashboard behavior before changing requests. Run `node chat.mjs --help` for the current flags.
