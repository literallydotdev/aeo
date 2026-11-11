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
| `gateway-search.json` | `mistral/mistral-large-4` (`@ai-sdk/gateway` 3.0.177) | `tool-call` with `input.query` (a string), matching `tool-result` with `output.results[]` of `{ title, url, snippet }` |

`gateway-search.json` was taken 2026-11-11 by `../default-bindings.live.spec.ts`
through the gateway's own search tool (`gateway.search@1`), then scrubbed:
results on hosts other than nodejs.org and github.com removed, snippets cut
to their first 80 characters, reasoning text, search ids and the gateway's
request and session ids replaced or dropped (marked `[…fixture-trimmed…]`
where a value remains). The tool attached no `source` parts to the answer.

## Consumer-app scrapes (`dataforseo/`)

Whole DataForSEO live responses for the two consumer-app surfaces (method
release spec §5), taken 2026-11-11 by `../consumer-surfaces.live.spec.ts`
in US English. The client in `../dataforseo.ts` and the two adapters are
tested against them.

| File | Endpoint | Shape pinned |
|------|----------|--------------|
| `ai-mode.json` | `/serp/google/ai_mode/live/advanced` | one `ai_overview` item with `markdown`, `references[]` of `{ source, domain, url, title, text }` and its `ai_overview_element` items; `cost` at the top level and on the task |
| `ai-mode-failed.json` | the same | a task that failed with 40101 ("Internal SE Server Error") under a top-level 20000, `result: null`, `cost: 0` |
| `chatgpt-app.json` | `/ai_optimization/chat_gpt/llm_scraper/live/advanced`, `force_web_search: true` | `model`, `items[]` of `chat_gpt_text`, `sources[]` of `{ title, url, ... }`, `fan_out_queries[]`, `search_results[]`, `cost` |

Both answered captures ask the question the chat fixtures use. Scrubbed:
task ids replaced, and in `chatgpt-app.json` the search results on hosts
other than nodejs.org and github.com removed. The buyer-question captures
of the same run name real products and are not kept here; the item types
only they produced (`chat_gpt_table`, `chat_gpt_images`) and the 40102
status no request returned are derived inside the tests.

## Fake CLI (`fake-cli/`)

`fake-cli.mjs` stands in for `claude`, `codex` and `cursor-agent` on PATH.
Its mode comes from `.fake-cli-mode.<cli>` under the runtime's HOME (the
name it was started as), else `.fake-cli-mode`. `replay <file>` prints one
of the captured streams above as the real CLI printed it; `result-only` is
a Claude Code result with no turn events (`usedWebSearch: null`); the other
modes exercise the child-process runner and the failure taxonomy.

## Golden pins (`golden/`, probe adapters spec §7, phase 1)

What 0.2.2 banks, journals and records for every probe path, read by
`../probes.golden.spec.ts`, `../agent-clis.golden.spec.ts` and
`../../pipeline.golden.spec.ts` through `golden-harness.ts`:

| File | Pins |
|------|------|
| `chat-probes.json` | Each chat path: the outcome, the banked probe, the journal port calls, the run journal, the provider request and the network requests |
| `agent-probes.json` | Each coding agent from a captured stream, a retried failure, a banking failure, the CLI arguments and the canaries |
| `capture-records.json` | Every surface's capture metadata, its manifest probe profile and the manifest itself |

The values were recorded from the code, reviewed, and are never
regenerated to make a test pass: a refactor that preserves behaviour
passes them unchanged, and a failing pin is a behaviour change to find. A
deliberate change (a method change with its version bump) edits the
affected value by hand, in the same change, and says why.
