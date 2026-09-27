# Spec B: Diagnose chat tool compatibility and establish trace completeness

## Problem Statement

A recipient of the shared CLI reported that a production agent could not call functions. The target agent and chat are unavailable, so the exact failure is not reproduced. The user also cannot see the full execution trace available for voice calls. These are distinct problems: missing visibility does not establish missing execution.

## Solution

Expose all schema-supported transcript function records now. Add portable setup/configuration diagnostics and explicit chat inputs. Build a minimal safe reproduction for reported tool failures, and determine whether full traces can be obtained from provider data or correlated backend instrumentation. Escalate provider gaps with a reproducible artifact rather than inventing trace events.

## User Stories

1. As a developer, I want to know whether my agent type supports tool execution in text chat, so that I choose the right test channel.
2. As a developer, I want to know which functions are linked and declared in the active prompt, so that configuration gaps are actionable.
3. As a developer, I want to supply required callAgentInput values, so that missing caller context does not masquerade as broken tools.
4. As a developer, I want to distinguish internal commit_answer calls from backend API calls, so that a trace does not overstate function execution.
5. As a developer, I want to see the received backend request and result when authorized instrumentation exists, so that I can separate selection from endpoint failure.
6. As a developer, I want to compare a safe control with the failing configuration, so that a fix follows reproduced evidence.
7. As a developer, I want to receive unsupported/inconclusive when full traces are missing, so that diagnosis stays honest.
8. As a developer, I want to share a minimal reproduction and configuration snapshot, so that Vogent can resolve provider limitations.

## Implementation Decisions

- Preserve the existing CLI entrypoint and message flags while introducing a deep conversation module behind a small command interface.
- Prefer one highest testing seam: invoke the real CLI as a process against an injected local provider adapter, then assert stdout/stderr, exit status and saved artifacts. Live provider contract checks are separate opt-in checks.
- Keep requested prompt, inspected default and proven execution version distinct. Current chat creation schema accepts agentId and callAgentInput, not a version selector.
- Keep provider chat capabilities distinct from documented dial capabilities. A field in the schema is not evidence that it is populated for every agent type.
- Record uncertainty and evidence provenance. Closing a client socket does not establish cancellation of backend effects.
- Keep credentials out of artifacts; raw transcripts and function arguments need private storage and redaction on export.
- General Vogent functionality must work outside Kyron. Put clinic acceptance rules and side-effect checks in an optional project adapter.

## Testing Decisions

- Test externally observable CLI behavior, including a failed later turn retaining earlier evidence, streamed errors returning failure, JSON output without banners, and unknown execution outcomes without automatic replay.
- Use the existing audit probes as failure-pattern evidence, not as a replacement for process-level regression tests. The current CLI has no dedicated chat integration suite in the inspected checkout.
- Replay sanitized recorded provider shapes and inject connection close, malformed frames, GraphQL errors and interrupted writes through the provider adapter.
- Validate the live undocumented interface with schema/readback checks. Fresh chat or tool-write checks require an isolated authorized target; never use production as the default test fixture.

## Out of Scope

Production deployment, changing agents or phone routes, creating dials by default, promising voice coverage from typed chat, and an embedded autonomous LLM test driver.

## Further Notes

### Fixability

- Available function-call display: confirmed CLI improvement. TranscriptLine.functionCalls exposes id, name and arguments. Existing saved chats populate commit_answer.
- Full voice-equivalent chat trace: conditional. NodeTransitionResult exposes fromNodeId, toNodeId and result, but all three readbacks had no records. FunctionCallRes has no dedicated return-value field. This does not prove backend functions did not execute.
- Shared production-agent function failure: unconfirmed. No agent identity, exact turn, expected function or chat artifact is available. Setup error is possible, not an established cause. The CLI always supplies an empty callAgentInput today; supported explicit inputs are a concrete improvement, but have not been proven to cause this report.
- Chat version pinning: CreateChatInput currently exposes only agentId and callAgentInput. Guarding defaults is possible; passing a dial-only version field to chat is not a supported fix.

A diagnostic ticket can start with a harmless isolated control without the recipient's artifact. Resolving the specific report requires that artifact or an equivalent red-capable reproduction; acceptance must allow an explicit unresolved finding.
