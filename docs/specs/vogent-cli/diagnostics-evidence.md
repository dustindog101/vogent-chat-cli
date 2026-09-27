# Vogent chat diagnostics evidence

Checked 2026-09-26 from the saved schema/readback evidence in `trace-verification.json`; this implementation pass made no new provider chat, turn, function call, or configuration change.

## Function compatibility

`diagnose-tools` reads the selected agent, active prompt, linked function definitions, typed phone-linkage state, expected function declaration, and explicit call-input names. It reports flow/link mismatches and input references that are not supplied. It emits only function IDs/names, endpoint host/path, input names, and evidence provenance; function headers, API body values, call-input values, transcript text, and function arguments are not returned.

Configuration evidence does not establish that a text-chat runtime supports a function or that an endpoint received a request. An empty call trace is not reported as proof that execution is impossible. A saved chat may be added to the same report for context without creating or sending a new chat.

`control-preflight` is a read-only gate. It returns ready only when the selected profile binds the exact agent and expected prompt, names an explicitly harmless function ID and endpoint allowlist, the prompt declares that linked function, typed phone-linkage evidence says `unlinked`, and an exact nonempty synthetic message is supplied. The command does not create a chat or send a turn. An unlinked agent or a general-purpose allowed target is insufficient.

## Trace population

Read-only introspection and three saved synthetic chat readbacks established that the `TranscriptLine` type exposes `functionCalls { id name arguments }` and `nodeTransitionResult { fromNodeId toNodeId result }`. The saved records had 1, 4, and 1 function calls, all named `commit_answer`; none contained a populated node transition. `FunctionCallRes` did not expose a dedicated result field.

The CLI trace report therefore distinguishes internal `commit_answer` calls from other provider-reported function calls, labels absent node transitions as unpopulated for that record, and labels function results unavailable. It never presents an internal answer commit as proof of a backend API request or receipt. Argument/result values are redacted; only names and counts are shown. Backend correlation is reported only when supplied identifiers match chat or function-call IDs. Timestamps alone are insufficient for exact attribution.

The report describes partial trace capability. It does not claim full Flow Builder voice-style trace parity, nor does an empty transition list prove that no flow node ran. See [trace verification](trace-verification.json) and [fixability findings](fixability.md) for the saved evidence and earlier interface assessment.

## Unresolved recipient report

No recipient agent, chat, exact message, expected API function, or endpoint receipt was supplied. The specific function-compatibility report remains unconfirmed; user error, missing inputs, configuration, backend access, and chat-runtime limitations remain possible until the same symptom is reproduced. The current diagnostic can expose configuration gaps and prepare an explicitly authorized harmless control, but this pass did not run one because no exact authorized isolated target was provided.
