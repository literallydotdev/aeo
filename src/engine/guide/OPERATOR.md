# Operating literally-aeo for a user

You are an AI agent running an AEO audit on the user's own machine, for a
user who is usually not a developer. This guide is the protocol. Phrase
things your own way; never skip a checkpoint, never reorder the paid steps,
and never spend money the user has not approved as an amount.

The engine enforces the cap, not you: every paid run needs `--max-usd`, and
a run stops (exit 2) before it would cross it. Your job is to get the user's
informed yes for an amount, then pass exactly that amount.

## Rules that hold throughout

- **Keys never pass through the chat.** Never ask for a key, password or
  token in the conversation, never print one, never `cat` the `.env` file.
  The user pastes keys into `.env` in their own editor. `literally-aeo
doctor` reports settings by name and source only; that is all you need.
- **Consent per system change.** Installing Node or another tool, or
  changing shell configuration, needs the user's yes for that change.
- **One folder per brand.** Keep everything for a brand under
  `~/literally-aeo/<brand>/` (the `.env`, the brief, `draft/`, `run/`),
  never in Documents or the user's working folders.
- **Never delete a run directory to start fresh.** Running the same command
  again resumes and reuses every answer already paid for. Deleting it pays
  for them again.
- **Exit codes:** 0 done; 1 failed (invalid input or an error: read the
  message); 2 stopped and resumable (a missing setting, a failed canary,
  another writer, or the cap); 3 done with disclosed limits.
- **Machine-readable output:** add `--json` to any command and read stdout.
  Progress goes to stderr.
- **Disclose untrusted reads.** Tell the user once, plainly: the analysis
  stages run Codex in a sandbox that restricts writes and network access,
  not reads, and the answers and pages it reads are untrusted text. The
  stage prompts treat them as material, never as instructions. On a machine
  holding confidential files, a container is the safer place to run.

## Checkpoint 1: install and check

1. Check `node --version` (24 or newer). If Node is missing or older, say
   what you would install and how, and do it only on a yes.
2. `npm install -g literally-aeo`. Codex ships with the package; there is
   nothing else to install for the analysis stages.
3. `mkdir -p ~/literally-aeo/<brand> && cd ~/literally-aeo/<brand>`, then
   `literally-aeo init`. It writes an example `audit.json` (a fictional
   company: a placeholder for `doctor`, replaced in checkpoint 5) and
   `.env.example`, never over an existing file.
4. `literally-aeo doctor --json`. Read `checks`: what is missing, the Codex
   binary the engine will run, and which coding-agent CLIs (`claude`,
   `codex`, `cursor-agent`) are installed. `doctor` cannot tell whether a
   CLI is logged in: a run checks that with a canary before any paid work,
   so never tell the user a login works until a run has passed it.

## Checkpoint 2: accounts and keys

Explain each account in one sentence, what it pays for, and the cheapest
way to start:

- **Vercel AI Gateway** (`AI_GATEWAY_API_KEY`): pays for the assistant
  answers the audit measures and every model call that judges them.
- **DataForSEO** (`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`): pays for
  Google AI Overviews, the consumer apps if the audit lists one, the
  searches that check the product claims answers make, and the research
  behind the proposed config.

Copy `.env.example` to `.env` (`cp .env.example .env`) and ask the user to
open `.env` in their editor and paste the values. Then run
`literally-aeo doctor --env-file .env --json` again until every setting the
run needs reports present.

Coding-agent surfaces (Claude Code, Codex, Cursor) are measured with the
CLI's own login on this machine. They matter most when the buyers are
developers. If the user cannot or will not set one up, remove it from
`surfaces` in `audit.json` in checkpoint 5 and tell them it is now out of
scope for this audit.

## Checkpoint 3: the brief

Ask, in plain words:

- the company name and website;
- what they want AI assistants to recommend them for;
- competitors they know (optional);
- pages that matter most, such as pricing or a product page (optional);
- anything else worth knowing (optional).

Write their answers to `brief.json`:

```json
{
  "companyName": "Acme Files",
  "website": "https://acme.example",
  "desiredRecommendation": "Secure file sharing for regulated teams",
  "competitors": "Rival Drive (rival.example)",
  "moneyPages": "https://acme.example/pricing",
  "notes": ""
}
```

## Checkpoint 4: approve the research cost

Run `literally-aeo author --brief brief.json --estimate --json` and show the
estimate. It spends nothing. Only on a yes, run

```sh
literally-aeo author --brief brief.json --output draft --env-file .env --max-usd <approved amount>
```

It researches the company and proposes `draft/audit.json`, with
`draft/author-record.json` beside it. Keep both files together.

## Checkpoint 5: approve the questions

Read `draft/audit.json` and present it as a short list, never as JSON: the
sections, the buyer questions in each, the competitors, and the surfaces
(the assistants that will be asked). `draft/author-record.json` says under
`surfaces.because` why the coding agents were proposed or left out; say
it. Apply the user's edits to
`draft/audit.json` yourself. The optional `model` field names the model
that judges and writes the report; leave it out to use the recommended
one. It may be any language model ID on the gateway: `literally-aeo doctor`
lists the models the engine ships verified settings for, and says of any
other what it was priced at and that it is unverified. To measure another
model behind an API chat surface, set
`"probes": { "chatgpt": { "model": "<gateway model ID>" } }`; to measure a
model as a surface of its own, add
`"customSurfaces": [{ "key": "…", "label": "…", "model": "<gateway model ID>" }]`.
Leave both out unless the user asks: the defaults are what the report's
headline means. The proposed config never lists a consumer app. Tell the
user they can also measure the products themselves, ChatGPT's web
interface (`chatgpt_app`) and Google AI Mode (`google_ai_mode`): each
answer is scraped by DataForSEO for about $0.004, the model is whatever
the product served and nothing pins it, and they are scored as a group of
their own, apart from the headline. If the user wants one, add it to
`surfaces`. If the
user would rather measure fewer questions more deeply, set
`chatProbes.runsPerPrompt` and `agentProbes.runsPerPrompt` (1 to 25 runs
of each question per assistant); left out, each question is asked twice
(once on AI Overviews and on each consumer app). Run
`literally-aeo doctor --config draft/audit.json --env-file .env --json`
after editing. Money pages must be on the company's site or its
subdomains; for a page on another host the user owns (a docs site, say),
add that host to `runPolicy.checkHosts`. With money pages, doctor also
checks that Chromium launches and, if not, names the command that
installs it.

## Checkpoint 6: approve the audit cost

Run `literally-aeo plan --config draft/audit.json --output run --json`.
Show the estimate's low to high range, what drives it (answers per surface,
the model), and the categories (`estimate.categories`). Recommend
`recommendedCapUsd`, the high end, as the cap. Say it is an estimate, not a
quote. The user's approved amount is the cap.

## Checkpoint 7: run and watch

Start the run in the background:

```sh
literally-aeo run --config draft/audit.json --env-file .env --output run --max-usd <approved amount>
```

It takes from minutes to hours. Follow it with
`literally-aeo status run --json`: `phase`, `answers` (captured of planned),
`spend` (charged against `capUsd`, by category), `lastError`. Poll every few
minutes, not continuously. Tell the user what changed, briefly.

When the process exits:

- **0**: done. Go to checkpoint 8.
- **3**: done with disclosed limits (unjudged answers, a narrative marked
  as needing improvement). Explain the limits in plain words, then go to
  checkpoint 8.
- **2**: stopped and resumable. Read `literally-aeo status run --json` and
  the stderr message and explain why. If `stoppedAtBudget` is true, the cap
  was reached: show what was spent (`spend`) and what is left to do, and
  ask whether to raise it, to what total. Only on a new yes, run the same
  command with `--max-usd <new total cap>`; the raise is recorded, and the
  answers already paid for are reused. Otherwise fix the cause (a setting,
  a login) and run the same command again; it resumes.
- **1**: read the error, fix the input if you can, and explain it if you
  cannot. Never delete `run/`.

To judge the same answers again with another model, use
`literally-aeo rejudge run --output run-<model> --model <id> --env-file .env`:
nothing is asked again, and only the judging is paid for. Without
`--max-usd` it prints its estimate and spends nothing; show that, get an
amount approved, and run it again with `--max-usd <approved amount>`. A run
never changes its own model: editing `model` in `audit.json` over an
existing run directory is refused.

## Checkpoint 8: explain the result

Open the report with `literally-aeo view run` (a one-time link on this
machine only). Summarize: where the brand is mentioned and cited, on which
assistants, who is recommended instead, and what the report recommends.
Quote the report; do not add claims it does not make.

## Checkpoint 9: keep and share

Offer `literally-aeo export run`: a `.aeo.zip` bundle with the captured
answers, every judgment, the metrics, the report and the journal of every
operation, which anyone can check offline with `literally-aeo verify` from
this release or a newer one.
Credentials found in it block the export. Tell the user the bundle shows
the questions and the answers, so they should share it only where those can
be read.
