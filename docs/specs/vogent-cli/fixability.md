# Trace and tool-call fixability

Verified 2026-09-26 with read-only live schema introspection and three existing synthetic chat readbacks. No new conversation, function invocation, dial or provider configuration change was performed.

## Missing traces

**Partially fixable now.** The CLI requests only transcript role/text, although the live TranscriptLine schema exposes functionCalls and nodeTransitionResult.

- FunctionCallRes fields: id, name, arguments. No dedicated return-value field was exposed on this type.
- NodeTransitionResult fields: fromNodeId, toNodeId, result.
- RunChatQueryStreamResult.transcriptLine uses that same TranscriptLine type, so expanding the stream selection is schema-valid. Actual stream population still needs a controlled contract test.
- aiChat(id: ID!) readback is verified with a trace selection.
- All three tested saved chats contained function calls named commit_answer (counts 1, 4 and 1), but no populated nodeTransitionResult records.

These internal calls are useful visibility, but are not a full trace of the Flow Builder's linked backend functions. Displaying them is a concrete CLI fix; claiming complete voice-style execution parity would be premature. Full trace work needs either populated provider records, correctly correlated backend instrumentation, or Vogent support. Schema absence on one type is not proof that no alternate provider interface exists.

## Shared production-agent functions

**Potentially fixable; exact failure is unconfirmed.** The user clarified that a recipient of the tool reported this and no target/repro artifact is currently available. User error is possible but unproven.

A concrete compatibility gap is that the CLI always creates a chat with empty callAgentInput. The live CreateChatInput schema supports a Map value there. Exposing explicit JSON inputs can support agents that need application/caller context, but this is not yet an established cause of the reported failure. The schema does not expose an explicit version selector for chat creation.

The diagnostic ticket first establishes a harmless control with expected backend invocation and endpoint receipt, then a red-capable reproduction of the reported symptom. It distinguishes setup/access, prompt/function declarations, missing inputs, backend failure and unsupported chat behavior through controlled comparisons. A fix is accepted only when the same reproduction passes. Without the recipient artifact or equivalent reproduction, the specific report remains unresolved; general portability and diagnostics can still ship.

## Evidence

[Sanitized readback verification](trace-verification.json) includes the exact query, IDs, response status and counts without function arguments or transcript text. The CLI assessment from the previous turn is superseded on the claim that the available chat trace schema is wholly unknown: function-call and transition fields are now established, while full runtime population is not.

Ticket 02 delivers available records. Ticket 07 establishes full trace completeness. Ticket 04 diagnoses compatibility. Ticket 05 exposes explicit chat inputs and verifies resume semantics. Ticket 03 improves shared-install setup diagnostics.
