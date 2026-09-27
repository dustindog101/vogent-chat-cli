# Spec A: Dependable Vogent chat development for coding agents

## Problem Statement

The working chat helper forces coding agents to recover evidence manually, cannot continue a chat across processes, and hides available function records. Stream errors may look like empty successful replies. Its staging classification and credential lookup are tied to a Kyron checkout, making shared-tool use hard to diagnose.

## Solution

Provide inspect, create/send/readback, durable evidence, available traces and reproducible scenarios through a portable CLI. Keep existing invocations compatible. Teach the workflow through a short agent skill that uses actual commands and distinguishes runtime evidence levels.

## User Stories

1. As a coding agent, I want to choose an exact agent and inspect deployed functions, so that I test the intended configuration.
2. As a coding agent, I want to consume JSON or JSONL, so that I do not parse human banners.
3. As a coding agent, I want to save each submitted turn and partial reply, so that failures retain debugging evidence.
4. As a coding agent, I want to read back an existing chat, so that I reconcile uncertain transport outcomes.
5. As a coding agent, I want to see available function calls and arguments, so that I understand tool selection.
6. As a coding agent, I want to see whether node traces are absent or unsupported, so that I do not mistake missing data for no execution.
7. As a coding agent, I want to continue a verified existing session, so that I choose inputs from actual replies.
8. As a coding agent, I want to pass explicit call inputs, so that required caller or application context is represented.
9. As a coding agent, I want to detect configuration drift, so that reproducibility is not based on node counts.
10. As a coding agent, I want to run a bounded scenario with exact assertions, so that behavior can be tested repeatedly.
11. As a coding agent, I want to reconcile tool side effects with exact records, so that spoken success is not my only evidence.
12. As a coding agent, I want to inspect a historical dial and its executed version, so that I compare the right configurations.
13. As a coding agent, I want to compare saved runs, so that improvements and regressions are visible.
14. As a coding agent, I want to use a focused skill, so that I do not rewrite GraphQL or recovery logic.
15. As a coding agent, I want to run the tool from another checkout or machine, so that setup is independent of Kyron.
16. As a coding agent, I want to receive a typed incomplete result, so that I avoid replaying a possible booking.
17. As a coding agent, I want to redact exported artifacts, so that I can share a useful defect without secrets or patient data.

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

Live read-only inspection passed in this session. Schema introspection established chat transcript functionCalls and nodeTransitionResult, call inputs, aiChat readback and message kinds APPEND_TEXT/NEW_SPEAKER_RES. Three saved staging chats contained commit_answer calls but no node transitions. Full Flow Builder function results remain unverified. Existing issue #2 tracks Kyron flow rendering/runtime acceptance; this specification tracks the developer tool and does not replace or close #2.

Implementation and publication approved. Test through the real CLI process with local provider fixtures; live checks are separately scoped.
