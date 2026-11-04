# Probe fixtures

## Agent CLI streams

Raw NDJSON stdout captured from the installed agent CLIs with the runner's
own invocation flags, then scrubbed (session ids, paths, usage and
rate-limit blocks removed; Cursor thinking deltas dropped). The parsers in
`../agent-cli-parsers.ts` are tested against these files; a CLI
output-format change shows up here first.

Two scrub generations: the three "searched" cases were re-captured on
2026-09-03 for the retrieval-log spec with **tool result payloads kept
whole** (they hold public URLs and titles, nothing sensitive), so the
Claude Code `Links:` array and the Cursor `chunk` list parse in full. The
other files carry the earlier 400-character string cap (marked
`[…fixture-trimmed…]`), which does not affect what they test.

| File | CLI | Case | Expected |
|------|-----|------|----------|
| `claude-code-searched.ndjson` | Claude Code 2.1.259 | `ToolSearch` loader, then `WebSearch` + `WebFetch` (whole payloads) | `true`; log: 1 search with result set, 1 fetch |
| `claude-code-no-tools.ndjson` | Claude Code 2.1.251 | plain answer, no tool calls | `false`; empty log |
| `claude-code-toolsearch-only.ndjson` | Claude Code 2.1.251 | only `ToolSearch` loader calls, web tools never found | `false`; empty log |
| `claude-code-permission-denied.ndjson` | Claude Code 2.1.251 | `WebSearch` attempted, listed in `permission_denials` | rejected-tool failure |
| `codex-searched.ndjson` | codex-cli 0.150.1 | two `web_search` items; the second completes with an empty query and `action.type: 'other'` (whole payloads) | `true`; log: 1 query, no results |
| `codex-multi-query.ndjson` | codex-cli 0.150.1 | a search whose `action.queries[]` holds two queries (`item.query` is the first plus " ..."), then an open-page call reported as `action.type: 'other'` with the URL in `item.query` (whole payloads) | `true`; log: 2 queries, 1 open_page |
| `codex-no-tools.ndjson` | codex-cli 0.150.1 | agent message only | `false`; empty log |
| `cursor-searched.ndjson` | cursor-agent 2026.09.02 | `--force` + deny list: `webFetchToolCall` then `webSearchToolCall`, both `result.success` (whole payloads) | `true`; log: 1 fetch, 1 search with result set |
| `cursor-web-rejected.ndjson` | cursor-agent 2026.09.02 | `--trust` only: search and fetch `result.rejected` | rejected-tool failure |
| `cursor-shell-denied-search-ok.ndjson` | cursor-agent 2026.09.02 | shell `permissionDenied`, search + fetch `success` | `true` |

Synthetic cases (torn lines, error results, an errored Codex search item, a
web-tool flag that disagrees with its log) are derived from these files
inside the test, not stored separately.

## Chat surface results (`chat/`)

One captured AI SDK `generateText` result per chat surface that exposes its
retrieval (retrieval-log spec §5.2), taken 2026-09-03 through the Vercel AI
Gateway with the runner's probe models and `toolChoice: 'required'`:
`steps[].content` parts plus `providerMetadata`, with Anthropic's
`encryptedContent` and Gemini's `searchEntryPoint` stripped. The extractors
in `../chat-retrieval.ts` are tested against these objects.

| File | Model (`ai` 6.0.77) | Shape pinned |
|------|---------------------|--------------|
| `openai.json` | `openai/gpt-5.4-mini` | `tool-result` part, `output.action.type: 'search'` with `query` + `queries[]`, `sources[]` of `type: 'url'` |
| `anthropic.json` | `anthropic/claude-sonnet-4.5` | `tool-call` with `input.query`, matching `tool-result` with `output: web_search_result[]` |
| `gemini.json` | `google/gemini-3-flash` (routed to Vertex) | `providerMetadata.vertex.groundingMetadata.webSearchQueries[]` |
