# Fixtures

`claude-envelope.json` is the stdout of `claude -p --output-format json` from Claude Code 2.1.312,
trimmed to the top-level fields and with `result` replaced by a sample answerer reply. It was
captured in a cloud container, not on the runner. Local verification step 3 replaces it with a
capture from the runner; if the field names differ, fix `parseEnvelope` in `src/answerer.ts`.
