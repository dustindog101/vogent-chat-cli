# Vogent text chat and trace workflow

Use the repository CLI from the checkout root. It reads `VOGENT_API_KEY` from the environment or an ignored root `.env.local`; `--env-file PATH` and `VOGENT_CHAT_HOME` support other installs. Never print or commit credentials. Run `node chat.mjs --help` for the current flags.

## Inspect and diagnose

```sh
node chat.mjs doctor
node chat.mjs --list
node chat.mjs --agent AGENT_ID --inspect
node chat.mjs diagnose-tools --agent AGENT_ID
node chat.mjs trace --chat-id CHAT_ID
node chat.mjs control-preflight --agent AGENT_ID --profile PROFILE --message 'Synthetic harmless control text'
```

`doctor`, `--list`, `--inspect`, `diagnose-tools`, `trace`, and `control-preflight` use read-only provider operations. The control preflight checks an explicit profile binding for the exact agent, prompt, function ID, endpoint and unlinked phone state; it never creates a chat or sends the message. A normal profile target does not count as harmless control authorization.

Profiles are private local CLI configuration. Set one only after reading back the exact target:

```sh
node chat.mjs profile set --name PROFILE --agent-id AGENT_ID --allow-target API_HOST/PATH_PREFIX --harmless-function-id FUNCTION_ID --harmless-target API_HOST/PATH_PREFIX --expected-prompt-id PROMPT_ID
```

The general allowed target controls chat acknowledgment. The separate harmless-control function and target fields opt that exact function/route into the read-only preflight.

`diagnose-tools` reports the active prompt and linked-function evidence, flow declarations, expected function selection, and input names without exposing function headers, body values, call-input values, transcript text, or arguments. An optional `--chat-id CHAT_ID` adds saved-chat evidence. Missing calls do not establish that text chat cannot execute a function. See [diagnostics evidence](../specs/vogent-cli/diagnostics-evidence.md) for the observed trace limits and unresolved recipient report.

## Run a bounded typed-chat check

Inspect the exact agent and function targets before creating a chat. A new chat persists at Vogent and may invoke linked functions; use an authorized isolated target and synthetic inputs.

```sh
node chat.mjs start --agent AGENT_ID --call-input '{"caller":"5550000000"}' --message 'Synthetic inquiry'
node chat.mjs scenario list
node chat.mjs scenario run --scenario work/scenario.json --agent AGENT_ID --ack-target AGENT_ID
```

`--ack-target` must equal the selected agent ID. A configured profile can authorize its exact agent and API targets. `--allow-live` is an interactive exact-agent-name acknowledgment. Keep scenario turns and assertions bounded; a scenario can create a chat and trigger linked functions. Read the scenario file’s `inputs.callAgentInput` and turns before running it.

The CLI preserves the chat ID and local evidence for recovery. After a timeout or interrupted turn, inspect that same chat before taking any further action:

```sh
node chat.mjs get --chat-id CHAT_ID
node chat.mjs trace --chat-id CHAT_ID
```

`send --chat-id ID --agent ID --message TEXT` continues locally associated chats after readback and exact target/configuration checks. Local process fixtures exercise this path, but live provider continuation has not been verified. A chat without a matching local session remains unsupported. Do not replay an uncertain turn until the saved chat and any relevant backend records have been reconciled.

## Compare a historical dial with a current chat

```sh
node chat.mjs dial export --dial-id DIAL_ID --redact
node chat.mjs trace --chat-id CHAT_ID
```

Keep each artifact’s ID and provenance. A dial can expose its executed prompt ID and voice lifecycle records; a chat readback does not prove which prompt version executed and does not test audio, ASR, interruption, transfer, or hangup. Internal `commit_answer` records are not backend endpoint receipts. Chat function arguments and transition results are summarized with values redacted; timestamps alone do not establish a backend correlation.

