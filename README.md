# Literally.dev AEO

Measure how AI assistants answer the questions your buyers ask: whether they
mention you, cite you, and who they recommend instead. `literally-aeo` runs
the audit on your own machine with your own provider keys, and writes a
portable evidence bundle that anyone can verify offline.

## Ask Claude to run this for you

You don't need to be a developer. Open Claude Code (the terminal app, or
the Code tab of the Claude desktop app) and paste:

> Run an AEO audit for acme.example with github.com/literallydotdev/aeo.
> Install it and follow `literally-aeo guide`.

Claude installs what is missing, asks a few questions about your company,
and asks you to approve an amount before anything is spent; the run cannot
spend more than that. You paste your provider keys into a file in your own
editor, never into the chat. `literally-aeo guide` prints the protocol
Claude follows, checkpoint by checkpoint.

## Run it yourself

```sh
npm install -g literally-aeo
literally-aeo init                       # audit.json and .env.example
literally-aeo doctor --env-file .env     # what a run needs, checked offline
literally-aeo plan                       # what a run would measure, and its estimated cost
literally-aeo run --env-file .env --max-usd 50   # measure under a cap; run again to resume
literally-aeo status audit-run           # phase, answers and spend, read-only
literally-aeo view audit-run             # local, loopback-only viewer
literally-aeo export audit-run           # a deterministic .aeo.zip bundle
literally-aeo verify audit-run.aeo.zip   # offline verification
```

## Requirements

- Node.js 24 or newer on Linux, where it is tested. macOS (Apple silicon)
  is expected to work but is not tested in CI. Windows users run it under
  WSL 2.
- Nothing else for the analysis and writing stages: the
  [Codex CLI](https://github.com/openai/codex) that runs them is a pinned
  dependency of the package.
- An `AI_GATEWAY_API_KEY` (Vercel AI Gateway) for the assistant answers and
  the host model calls, and a DataForSEO login for Google AI Overviews, the
  consumer apps and factual grounding searches.
- For coding-agent surfaces, the CLI of each one you measure (Claude Code,
  Codex, Cursor) and its own login.
- For `moneyPages`, Playwright's Chromium, which renders each page for the
  renderability check (`literally-aeo doctor` names the install command).
  Money pages must be public https pages on the brand's site or its
  subdomains; a page on another host needs that host in
  `runPolicy.checkHosts`, at most 20 of each. Every request the site checks
  make, the browser's included, goes only to public addresses.

## Model and cost

One model judges the answers, researches the claims and writes the report:
`"model"` in `audit.json`, any language model ID on the gateway. Leave it
out to use the recommended model, because judgment and writing quality are
the report. The engine ships verified settings for the models
`literally-aeo doctor` lists. Any other model is priced from the gateway's
public model list, at the highest price the list shows for it, and that
price is kept for the whole run. Such a model was never verified on the
analysis stages, which `doctor` says; it is refused only when the list has
no price for it. Without network access to the list, set
`AEO_MODEL_CATALOG` to a saved copy of
`https://ai-gateway.vercel.sh/v1/models`.

Each API chat surface (`chatgpt`, `claude`, `gemini`, `perplexity`) asks a
pinned model: the gateway model closest to what that product serves its
free tier by default. To measure another model behind a surface, name it
in `audit.json`:

```json
"probes": { "chatgpt": { "model": "openai/gpt-6-sol" } }
```

Any model works, with no further check. A model of the surface's own
provider is asked through that provider's web search; a model of another
provider searches through the gateway's own search tool. Either way it is
priced from the same model list and named in the surface's label ("ChatGPT
(API, openai/gpt-6-sol)"). A run keeps the models it started with. Swapping
a model does not change what the run measures (the questions, surfaces and
depth), only how; a comparison with an earlier run says the collection
method changed.

To measure a model as a surface of its own, declare it:

```json
"customSurfaces": [
  { "key": "mistral", "label": "Mistral Large 4", "model": "mistral/mistral-large-4" }
]
```

Up to eight. A custom surface is asked every question, as often as the chat
surfaces, in the audit's country and language, through the gateway's search
tool. It is scored on its own line, under its label and its model, and it
is never part of the headline rates: those stay the four API chat surfaces
and Google AI Overviews, so they keep meaning the same thing from one
report to the next. That tool attaches no source list to an answer, so a
custom surface's citation rate counts only the links the model writes in
its answer. A model that cannot call the search tool fails its answers one
by one; there is no check before the first paid call.

### The consumer apps

The four chat surfaces ask each provider's API, which is the nearest thing
to its product that can be pinned. To measure the products themselves, list
them in `audit.json`'s `surfaces`, beside the ones you already measure:

```json
"surfaces": ["chatgpt", "gemini", "claude", "perplexity", "chatgpt_app", "google_ai_mode"]
```

`chatgpt_app` is ChatGPT's web interface with its search on, and
`google_ai_mode` is Google's AI Mode. DataForSEO scrapes each answer from
the product's page, so a run that lists one needs the DataForSEO login. A
scrape costs about $0.004; judging the answer costs what judging any other
answer does, and `literally-aeo plan` shows the total. They are measured
only when listed, and what they measure differs from the API surfaces in
ways the report states:

- Nothing pins the model. The report shows the model the scraper read off
  ChatGPT's page, and none for AI Mode. Whether the scraper's session is
  logged in is not documented, so which tier of the product answered is not
  known.
- A ChatGPT answer is the text and tables of the page; everything else on
  it, such as images, shopping results and advertisements, is left out. A
  citation counts the sources the scraper lists as cited or relied on, and
  the links in the answer.
- AI Mode always answers in the product, so a scrape that comes back empty
  is a failed answer, retried once and then counted as missing. It is never
  an answer that did not mention you.
- Each question is asked once per app, or as often as `chatProbes` says.
- They are scored as a group of their own, with their own pair of rates.
  The headline stays the four API chat surfaces and Google AI Overviews, so
  adding a consumer app changes no headline rate, no other surface's rates
  and no competitor split. The source mix and the outreach list count every
  captured answer, so they include its answers. A comparison with a run
  that did not measure it reports that the scope changed.
- Both scrapes were captured in US English only (November 2026).
  DataForSEO lists the markets each one serves; in a market it refuses,
  every answer of that app fails and the run stops at its coverage check.

`literally-aeo plan` estimates what a run costs, as a range per kind of
work: the assistant answers, the analysis stages, the other model calls and
the searches. A run does not start without a cap you approve
(`--max-usd`), and the cap covers all of that work: the run stops,
resumable, before a call would cross it. A run keeps its model and its cap;
`rejudge --model` judges the same answers with another model in a new run
directory.

Nothing is sent to Literally.dev: no telemetry, no account, no upload.
A run contacts only the providers you configure and the sites it checks.

## How deep each question goes

By default each question is asked twice on every assistant, and once on
Google AI Overviews and on each consumer app. To measure fewer questions
more deeply, set the depth in `audit.json`:

```json
"chatProbes": { "runsPerPrompt": 12 },
"agentProbes": { "runsPerPrompt": 12 }
```

`chatProbes` covers the chat assistants, AI Overviews and the consumer apps
included, and `agentProbes` the coding agents; each takes 1 to 25 runs per
question. `literally-aeo plan` shows the answers and the cost a depth plans
before anything is spent. Depth is part of what a run measures, so keep it
the same across the runs you mean to compare: a progress comparison between
runs at different depths reports that the scope changed, not a change in
visibility.

## How sure a number is

A rate is a share of the planned answers: "mentioned in 2 of 8". With so few
answers, a bare "25%" says more than was measured. Every rate therefore
carries its counts and an approximate 95% interval (a Wilson score
interval), and the report and the viewer show the interval beside the rate.

- The interval describes answer-to-answer variation for these questions at
  the time of the audit. It is not a market share and not a forecast.
- An answer that was planned and not captured counts as "not mentioned" in
  the rate, and the interval widens to allow for either outcome.
- It assumes repeated runs of one question are independent. Runs minutes
  apart can share a search index or a cache; if they return near-duplicate
  answers, the interval is too narrow. Perplexity often lists the same
  sources in both runs of a question: those two runs are one observation of
  whether you are cited, not two, and the interval does not allow for that.
- A comparison of two runs says whether each change is larger than
  answer-to-answer variation, by an exact test, with its p-value. It never
  says why a number changed, or that the change will last.

Every report carries a methodology section, built by the engine and not
written by a model: the models asked, what is not measured, and what the
numbers mean.

## A run keeps its method

A run directory records, before its first paid call, how it measures: the
calculation and prompt versions, the model behind each surface, and the
price of any model the engine has no entry for. Running it again resumes it
the same way. A release that measures another way refuses to resume it, and
says which release finishes it. `rejudge` judges its answers under the
installed release in a new directory. An exported bundle states the method
the run was made with, from what the directory recorded, whichever release
exports it.

## What a run produces

A run directory holds the captured answers, every judgment, the computed
metrics, the report copy and a hash-chained journal of every operation the
host observed: each probe attempt, each model call with its exact request
and response, each research search and fetch, each technical check, and each
Codex session. `export` turns it into a `.aeo.zip` bundle; `verify`
recomputes the metrics from the bundled judgments, checks every hash and the
journal chain, and states plainly what it could not check. Verify a bundle
with the release that exported it or a newer one: an older release reports
a bundle format it cannot read as unsupported (exit 2) instead of checking
it.

Verification proves the bundle is internally consistent and unaltered since
export. It cannot prove that a provider really returned an answer: the bundle
is evidence its producer recorded, not a third-party attestation.

## As a library

The command is the supported interface, along with `literally-aeo/contracts`
(the report and measurement schemas). Every other module is importable by its
path, for example `literally-aeo/bundle/verify`, because Literally.dev's
hosted service runs this same engine. Those paths are internal: they can
change in any release, so pin an exact version if you use them.

## Development

```sh
pnpm install
pnpm test          # deterministic and free; *.live.spec.ts files are not run
pnpm typecheck
pnpm lint
pnpm cli plan      # the CLI from source
pnpm build         # dist/ and resources/, as the package ships them
```

Releases publish from this repository's `release.yml` when a `vX.Y.Z` tag is
pushed. The version lives in `package.json` and in `toolVersion`
(`src/bundle/contracts.ts`), which every journal and bundle records; the
build refuses a mismatch.

## License

MIT, copyright Literally AS. See [LICENSE](LICENSE).
