# Development assessment and evidence limits

The original helper supports agent selection and typed turns, but coding agents need durable evidence, saved-chat readback, configuration checks and structured output to use it reliably. The migrated implementation provides those workflows; this is a stopped development candidate with unresolved tickets, not a completed production acceptance.

## Confirmed discoveries

- Chat uses dashboard GraphQL operations rather than a documented public text-chat contract.
- The observed chat creation input exposes `agentId` and `callAgentInput`; an explicit chat prompt-version selector was not exposed.
- Chat transcript lines expose `functionCalls { id name arguments }` and `nodeTransitionResult { fromNodeId toNodeId result }`. The observed function-call type has no dedicated return-value field.
- Existing synthetic chat records populated internal `commit_answer` calls but no node-transition records. That establishes partial visibility, not complete Flow Builder execution tracing.
- The stream message kinds observed in the schema are `APPEND_TEXT` and `NEW_SPEAKER_RES`.
- A WebSocket timeout or close does not prove that a backend function did not execute. Preserve evidence and reconcile before retrying.

## Improvements and verification

Structured JSON/JSONL, private journals, typed failures, readback/export, explicit call inputs, portable diagnostics/profiles, configuration snapshots and drift checks, historical dial export, bounded scenarios, optional read-only effect reconciliation, offline comparisons and an agent skill were implemented. Independent process tests identified input precedence and redaction bugs that were fixed before this migration.

Local fixture checks do not prove live provider compatibility. Live cross-process continuation remains unverified; the reported third-party function failure has no supplied target or reproduction. Full native chat traces, scenario status precedence, independent suite acceptance and final skill/review acceptance remain open in the tracker. See the stop-point and review handoffs.

## Primary sources

- [List agents](https://docs.vogent.ai/api-reference/list-agents) and [Get versioned prompt](https://docs.vogent.ai/api-reference/get-versioned-prompt) support read-only deployed configuration inspection.
- [Get dial](https://docs.vogent.ai/api-reference/get-dial) documents historical voice-call evidence; it is distinct from text-chat trace support.
- [Create dial](https://docs.vogent.ai/api-reference/create-a-new-dial) documents dial version selection and idempotency. These guarantees must not be assumed for chat.
- [Flow Builder](https://docs.vogent.ai/platform-overview/agents/model/flow-builder) and [schemas](https://docs.vogent.ai/developers/schemas) explain graph/function configuration, not actual presentation or execution correctness.

The public repository deliberately excludes account credentials, environment addresses, live chat/prompt identifiers, patient content and private project records. Its fixtures use synthetic data.
