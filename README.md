# Vogent Chat CLI and Agent Skill

A dependency-free Node.js CLI and AI agent skill for typed conversations, agent inspection, scripted multi-turn evaluation, and transcript log retrieval with [Vogent](https://vogent.ai) AI voice and chat agents over WebSocket (`graphql-transport-ws`).

---

## Features

- **Zero External Dependencies**: Pure Node.js (v22+) utilizing native `fetch`, `WebSocket`, and `readline/promises`.
- **Account & Agent Inspection**: List all agents and inspect active versioned prompts, flow node counts, phone linkage, and linked backend API endpoints without starting a chat.
- **Interactive Multi-Turn Chat**: Real-time terminal dialogue with any agent (`/quit` to exit).
- **Deterministic Scripted Conversations**: Chain sequential user turns using multiple `--message` flags to run automated regression dials.
- **Full Transcripts & Tool Execution Traces**: View full conversation history, assistant messages, tool/function calls (such as `commit_answer` or backend API calls), and node transition results using `--transcript` or `--chat-id <ID>`.
- **Machine-Readable Exports**: Dump complete transcript payloads in raw JSON using `--json`.
- **Live Safety Guard**: Enforces explicit confirmation or the `--allow-live` flag before executing against phone-linked or live agents.
- **Configurable Timeouts**: Adjust per-turn WebSocket response deadlines via `VOGENT_CHAT_TIMEOUT_MS`.
- **Ready-to-Use Agent Skill**: Bundled `SKILL.md` allows any AI coding agent (Antigravity, Codex, Claude Code, Cursor) to self-onboard, prompt for credentials, and run evaluations autonomously.

---

## Requirements and Setup

### 1. Prerequisites
- **Node.js**: v22 or newer (uses native `fetch` and `WebSocket`).
- **Vogent API Key**: A valid bearer token for `api.vogent.ai`.

### 2. Configuration
The CLI reads credentials from the `VOGENT_API_KEY` environment variable or an untracked `.env.local` file placed beside `chat.mjs`:

```bash
# Option A: Save to local untracked file (recommended)
echo "VOGENT_API_KEY=your_vogent_api_key_here" >> .env.local

# Option B: Export environment variable
export VOGENT_API_KEY="your_vogent_api_key_here"
```

> [!CAUTION]
> Never commit `.env.local` or pass API keys as CLI arguments.

### 3. Verify Connection
```bash
node chat.mjs --list
```

---

## Commands & Usage

### 1. Discover and Inspect Agents

```bash
# List all agents in the account
node chat.mjs --list

# Inspect an agent's configuration without starting a chat
node chat.mjs --agent 'Agent Name or ID' --inspect
```

Output includes:
- Agent ID and Name
- Active versioned prompt ID and flow node count
- Phone linkage status
- Linked functions and backend endpoint targets

---

### 2. Interactive Terminal Chat

```bash
node chat.mjs --agent 'Agent Name or ID'
```

- When chatting with an agent that may invoke live backend functions, the CLI prompts you to type the agent's name to confirm.
- Type your messages interactively.
- Type `/quit` to end the session.

---

### 3. Scripted Multi-Turn Evaluation

Chain multiple `--message` flags to send sequential turns. Each turn is sent only after the agent finishes streaming its response:

```bash
node chat.mjs \
  --agent 'Agent Name or ID' \
  --allow-live \
  --message "Hi" \
  --message "What clinic locations do you have?"
```

#### Example Output:
```text
Agent: Medical Scheduler Agent (188872cb-a29f-4dea-9540-769526760644)
Active prompt: febbc577-39d6-486c-953a-5d248f325e8d; flow nodes: 96
Chat ID: 35664c12-cab0-49a6-8ad9-852b6a2762f9

[Turn 1] You: Hi
[Turn 1] Agent: Thanks for calling Kyron Medical. I'm the scheduling assistant. How can I help?

[Turn 2] You: What clinic locations do you have?
[Turn 2] Agent: We have locations in Sacramento, Granite Bay, and Roseville.
```

---

### 4. Viewing Session Transcripts & Tool Execution Traces

#### Option A: Auto-Display at End of Chat
Add `--transcript` (or `--history`) to print the full transcript and tool calls immediately upon completion:

```bash
node chat.mjs \
  --agent 'Agent Name or ID' \
  --allow-live \
  --message "Hi" \
  --message "What kinds of visits do you handle?" \
  --transcript
```

**Output:**
```text
=== Full Session Transcript & Tool Logs ===
  [1] You: Hi
  [2] Agent: Thanks for calling Kyron Medical. I'm the scheduling assistant. How can I help?
  [3] You: What kinds of visits do you handle?
      ⚡ Function Call: commit_answer({"answer":"The caller is asking what kinds of visits are handled."})
  [5] Agent: I can help with appointments and questions about our doctors. What would you like to know?
===========================================
```

#### Option B: Retrieve Any Past Session by Chat ID
Retrieve and review past sessions at any time using their Chat ID:

```bash
# Formatted turn-by-turn transcript and tool calls
node chat.mjs --chat-id <CHAT_ID>

# Machine-readable JSON output
node chat.mjs --chat-id <CHAT_ID> --json
```

---

## Environment Variables & Overrides

| Variable | Description | Default |
| :--- | :--- | :--- |
| `VOGENT_API_KEY` | Bearer token for api.vogent.ai | Read from `.env.local` |
| `VOGENT_CHAT_TIMEOUT_MS` | Per-turn WebSocket timeout (5,000 to 180,000 ms) | `45000` (45s) |

---

## Using as an Agent Skill

This repository functions as an autonomous skill for AI coding assistants (such as Antigravity, Codex, Claude Code, or Cursor).

### Installation into Agent Skills Directory
Clone this repository into your agent's skills directory:

```bash
# For Codex / Claude Code
git clone https://github.com/dustindog101/vogent-chat-cli.git ~/.codex/skills/vogent-chat

# For Antigravity / Project-level skills
git clone https://github.com/dustindog101/vogent-chat-cli.git .agents/skills/vogent-chat
```

### Self-Setup Capability
Once installed, you can simply ask your agent:
> *"Use the vogent-chat skill and set it up for me."*

The agent will automatically:
1. Verify if `VOGENT_API_KEY` is present.
2. Ask you for the key if missing.
3. Save it to `.env.local` securely.
4. Verify connection by running `node chat.mjs --list` and report your agents.

---

## Diagnosing Failures

When a turn fails, the error includes Vogent's close code, elapsed time, the number of stream events received, and any partial text:

```text
Vogent chat WebSocket failed (code 1006, after 60s, 1 stream events; partial: Who are your doctors?).
```

- **Close 1006 after ~60s with no reply:** the flow stalled inside Vogent. The turn is usually not saved to the chat record. If the agent's API functions show no request at that moment (check your backend logs), the question-node model most likely tried to call a *linked function* as a tool. Link only the functions your flow's function nodes use, describe them as flow-only (e.g. "Invoked by a flow function node. Never call this tool yourself."), and keep tool-like wording out of question guidance.
- **Empty reply:** either the call ended (a terminal function node's start message, such as a goodbye, is spoken on phone calls but not streamed in text chat), or a transient platform error. Check whether your end-of-call webhook fired.
- Raise `VOGENT_CHAT_TIMEOUT_MS` (default 45000, max 180000) to see the close code instead of a local timeout.

## Using It from Another Script

`chat.mjs` only runs the CLI when executed directly, so scripts can import it, e.g. to build scenario tests:

```js
import { createChat, credential, readChat, sendTurn } from './chat.mjs';

const token = credential();
const chatId = await createChat(AGENT_ID, token);
const reply = await sendTurn(chatId, 'Hi, I need an appointment.', token);
const record = await readChat(chatId, token); // saved transcript
```

Replies are the agent's spoken text. Decide the next caller line by matching the agent's reply rather than by turn number: flow wording and model phrasing change between runs.

## Limitations (Chat vs Phone Calls)

- **Text Pipeline Only**: The CLI connects to Vogent's text chat pipeline (`createAiChat` & `runChatQueryStream`). It evaluates prompt adherence, state routing, and linked function execution.
- **Audio & Telephony**: It does **not** exercise Cartesia/ElevenLabs TTS, speech recognition (ASR), background audio streaming, interruption handling, or SIP phone transfers.
- **Saved Chat Records Are Partial**: The saved transcript includes the model's internal `commit_answer` calls but not API function calls, their results, or node transitions. To prove a lookup or booking ran, check your backend's request logs. Phone dials (`GET /api/dials/{id}`) do include node transitions.

