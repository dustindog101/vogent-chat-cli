---
name: vogent-chat
description: Use when working with this repository's Vogent CLI to inspect an agent, run typed chat or scenarios, diagnose function compatibility, read saved chat traces, or export a historical dial.
---

# Vogent chat development

Use `node chat.mjs --help` for current flags. Use the CLI for provider access; do not write ad hoc GraphQL requests.
For credential setup and the full command workflow, see [the Vogent chat guide](docs/chat.md).

Inspect the exact agent before any chat or scenario run:

```sh
node chat.mjs doctor
node chat.mjs --agent AGENT_ID --inspect
node chat.mjs diagnose-tools --agent AGENT_ID
```

`diagnose-tools` checks prompt/function links and explicit call-input names. It cannot prove chat-runtime support or an endpoint receipt. Read [diagnostics evidence](docs/specs/vogent-cli/diagnostics-evidence.md) when investigating missing tool calls or incomplete trace records. `trace --chat-id ID` reports what the saved chat populated; an internal `commit_answer` call is not proof of a backend request, and missing transitions do not prove that no flow node ran.

Create typed chats only for an authorized isolated target with synthetic inputs. A chat persists and may call linked functions. Use one `--message` per turn and supply application context with `--call-input JSON` when required. For repeatable runs, inspect the scenario file and use:

```sh
node chat.mjs scenario list
node chat.mjs scenario run --scenario FILE --agent AGENT_ID --ack-target AGENT_ID
```

After a timeout or interrupted turn, recover from the same chat before considering another action:

```sh
node chat.mjs get --chat-id CHAT_ID
node chat.mjs trace --chat-id CHAT_ID
```

`send --chat-id ID --agent ID --message TEXT` can continue a locally created session after readback and target/configuration preflight. This path passed local process fixtures; live provider continuation has not been verified. Chats without a matching local session remain unsupported. Never infer successful backend effects from assistant wording or replay an uncertain write before checking the saved chat and relevant backend records.

For a historical voice call, use `node chat.mjs dial export --dial-id DIAL_ID --redact`. Compare its executed-prompt evidence with the current-chat trace while keeping chat and dial capabilities separate.
