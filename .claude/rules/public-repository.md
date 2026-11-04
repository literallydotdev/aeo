# Public Repository

This repository, its history, its issues and its npm package are public under
MIT. Anything committed here is published, and history keeps it after a later
deletion. Check every file you add or change against this rule before
proposing a commit.

## Never add

- **Client and prospect data.** No real company names, domains, audit
  configs, captured answers or reports of anyone the maintainers work with.
  Test data uses reserved names: `acme.example`, `rival.example`,
  `example.org`, `Acme Files`.
- **Private company context.** No revenue figures, sales or deal notes,
  unannounced relationships, positioning work or internal strategy. The
  engine's editorial context is the neutral one in `src/engine/editorial/`;
  a publisher's own files reach a run only through `AEO_EDITORIAL_DIR`, at
  run time, never through the repository.
- **Credentials and infrastructure.** No keys, tokens, database URLs, cloud
  account IDs, internal hostnames or ARNs. Tests use obvious fakes
  (`arn:aws:secretsmanager:eu-north-1:1:secret:x`).
- **Run artifacts.** Run directories, bundles (`*.aeo.zip`), `.env` files and
  logs stay out; `.gitignore` covers the usual names, but a renamed copy is
  not covered, so look.

## The one exception

`src/__fixtures__/replay/literally-2026-q3` is Literally.dev's own self-audit:
assistant answers and the report snapshot. It holds no client data. Adding
another real-world fixture needs the same kind of explicit decision by the
maintainers.

## Before proposing a commit

- Search the change for real brand names and domains that are not
  Literally.dev, the public AI providers, or reserved example names.
- Read comments, not only code: private context hides in explanations of why
  a rule exists ("the X run on 2026-09-03"). Name the run generically.
- When in doubt, leave it out and ask.
