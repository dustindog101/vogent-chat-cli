# Scenario examples

These JSON files are templates. Replace every `REPLACE_...` value and use an isolated test target before running them. Each run creates a new Vogent text chat and may invoke linked API functions. The built-in Kyron adapter only reads `GET /api/appointments`; it never books, edits, or cleans up records. Point its `baseUrl` at a local isolated fixture by default. Remote effect reads require an explicit exact-target acknowledgment.

Run one scenario with:

```sh
node chat.mjs scenario run --scenario vogent/examples/greeting-alignment.scenario.json --agent YOUR_UNLINKED_STAGING_AGENT_ID
```

Run the bounded suite with:

```sh
node chat.mjs suite run --scenario vogent/examples/regression-suite.json --max-scenarios 2
```

The suite runs one scenario at a time and starts a distinct fresh chat for every member. The booking example remains incomplete if its persisted chat, explicit caller confirmation, exact appointment row, or before/after effect snapshots are missing.

Compare two saved runs offline with:

```sh
node chat.mjs scenario compare --before PATH_TO_OLDER_RUN.jsonl --after PATH_TO_NEWER_RUN.jsonl
```

Comparison reads only the two local journals and reports incompatible evidence schemas as inconclusive.
