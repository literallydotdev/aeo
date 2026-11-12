# Frozen bundles

Bundles exported by earlier releases, kept byte for byte so the verifier
is tested against what those releases actually wrote. The synthetic run in
`../synthetic-run.ts` is rebuilt with current code, so on its own it
cannot catch a regression in reading an old bundle.

Each one is the fictional synthetic run (`acmebase.test`), created and
exported with the code of the commit named below:

| File | Commit | Bundle schema | Calculation version | Depth |
|---|---|---|---|---|
| `schema-1-0.2.0.aeo.zip` | `3113365` (published 0.2.0) | 1 | 1 | standard |
| `schema-2-12df4f5-depth-3.aeo.zip` | `12df4f5` (unpublished 0.2.0 build) | 2 | 1 | `chatProbes.runsPerPrompt: 3` |
| `schema-2-0.3.0.aeo.zip` | `f69e22e` (published 0.3.0) | 2 | 1 | standard |
| `schema-3-0.4.0.aeo.zip` | `328f63f` (published 0.4.0) | 3 | 2 | standard |
| `schema-3-0.4.0-consumer-apps.aeo.zip` | `328f63f` (published 0.4.0) | 3 | 2 | standard, with `consumerApps: ['chatgpt_app', 'google_ai_mode']` |

They were made by extracting each commit (`git archive <commit>`),
installing its locked dependencies, and running, from the extracted tree:

```ts
const run = await createSyntheticRun(dir, options); // {}, { chatProbes: { runsPerPrompt: depth } } or { consumerApps }
await exportRun(run.dir, { output });
```

Never regenerate one with current code: a frozen bundle that changes is no
longer evidence of what its release wrote. Add a new file for a new release
instead.
