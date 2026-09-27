---
name: vogent-chat
description: Setup and operate the Vogent Chat CLI to test agent conversations, inspect flow prompts, run scripted multi-turn tests, and analyze tool call transcripts. Use this skill when asked to set up Vogent chat, run text dials, debug agent behavior, or inspect chat transcripts.
---

# Vogent Chat Skill

Use this skill when asked to configure Vogent chat, inspect agents, run interactive or scripted text conversations, or analyze full transcript logs and tool executions.

---

## 1. Automated Setup & Onboarding Protocol

When a user asks:
- *"Use this skill and set it up for me"*
- *"Set up Vogent chat"*
- *"Configure my Vogent credentials"*

The agent MUST follow this step-by-step setup procedure:

### Step 1: Check Existing Credentials
Check whether `VOGENT_API_KEY` is present in the current environment or in `.env.local` located beside `chat.mjs`:
```bash
node -e '
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(root, ".env.local");
const hasEnv = Boolean(process.env.VOGENT_API_KEY);
const hasFile = existsSync(envFile) && readFileSync(envFile, "utf8").includes("VOGENT_API_KEY=");
console.log(JSON.stringify({ configured: hasEnv || hasFile }));
'
```

### Step 2: Prompt User for API Key (If Missing)
If neither exists:
1. Ask the user for their Vogent API key directly:
   > "To set up the Vogent Chat CLI, I need your Vogent API key. Please provide your key so I can configure it securely in `.env.local`."
2. When the user provides the key, write it to `.env.local` beside `chat.mjs`:
   ```bash
   echo "VOGENT_API_KEY=YOUR_KEY_HERE" >> .env.local
   ```
3. Verify that `.gitignore` contains `.env.local` so secret keys are never committed:
   ```bash
   git check-ignore -q .env.local && echo "Protected" || echo "WARNING: Add .env.local to .gitignore"
   ```

### Step 3: Verify Connection & Report Status
Test connectivity with the Vogent GraphQL API:
```bash
node chat.mjs --list
```
- If successful, report the discovered agents back to the user and confirm that setup is complete.
- If it fails (e.g., HTTP 401 or network error), inform the user of the error and prompt them to verify the API key.

---

## 2. Agent Operation Playbook

### A. Inspect Agent Before Starting
Before initiating any chat session, inspect the agent to review its active prompt, node count, and linked backend API endpoints:
```bash
node chat.mjs --agent 'Agent Name or ID' --inspect
```

### B. Run Scripted Multi-Turn Tests
To execute deterministic multi-turn conversations, chain `--message` arguments. When testing agents that may invoke live functions or phone lines, supply `--allow-live`:
```bash
node chat.mjs \
  --agent 'Agent Name or ID' \
  --allow-live \
  --message "Hi" \
  --message "What clinic locations do you have?"
```

### C. Review Transcripts and Tool Execution Traces
To see what tools/functions were invoked during a conversation (e.g. `commit_answer`, directory search):
1. **At the end of a chat session**: Add `--transcript` to the command.
2. **For any past session**: Use the Chat ID reported during the run:
   ```bash
   # Formatted transcript and tool calls
   node chat.mjs --chat-id <CHAT_ID>

   # Raw machine-readable JSON
   node chat.mjs --chat-id <CHAT_ID> --json
   ```

---

## 3. Reference Documentation

For detailed command options, environment variables, and usage examples, refer to [README.md](README.md).
