# Agent Harness: Map and Sync Rules

A map of the AI-agent instruction files in this repository and the invariants
that keep the three tools (Claude Code, Cursor, Codex) from drifting. It is
not imported into any agent's context.

## One body of guidance, three tools

- **Claude Code** reads `CLAUDE.md`, which imports `AGENTS.md` and
  `docs/engineering-principles.md`, and loads every `.claude/rules/*.md` file
  in every session.
- **Cursor** reads `.cursor/rules/*.mdc`; the frontmatter (`alwaysApply`,
  `globs`) decides when each rule loads.
- **Codex** reads `AGENTS.md`; its "Agent harness" section points at the rule
  files instead of repeating them.

## File inventory

| Concern                | Canonical copy                   | Mirrors                                                                                                              |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Engineering principles | `docs/engineering-principles.md` | imported by `CLAUDE.md`; full body in `.cursor/rules/engineering-principles.mdc`; compressed rulebook in `AGENTS.md` |
| TypeScript style guide | `docs/typescript-style-guide.md` | not auto-loaded; linked from `AGENTS.md` and the principles; applied by the `code-style` skill                       |
| Topic rules (7)        | `.claude/rules/*.md`             | `.cursor/rules/*.mdc` (same body plus frontmatter)                                                                   |
| Skills (3)             | `.claude/skills/<name>/SKILL.md` | byte-identical twin at `.agents/skills/<name>/SKILL.md`                                                              |

Topic rules: `public-repository`, `measurement-stability`, `evidence-honesty`,
`untrusted-input`, `tests-cost-nothing`, `eslint-suppressions`,
`git-operations`.

Skills, all user-invoked (`disable-model-invocation: true`): `scrutinize`,
`scrutinize-wide`, `code-style`.

`git-operations` is stated twice on purpose: in short in `AGENTS.md`, read
before any tool call, and in full in the rule file. A rule consulted only
after the agent has decided to commit arrives too late.

## Sync invariants

1. Rule prose lives once: `.claude/rules/X.md` is `.cursor/rules/X.mdc`
   without its frontmatter. Edit one, sync the other.
2. `.cursor/rules/engineering-principles.mdc` tracks
   `docs/engineering-principles.md`; the compressed rulebook in `AGENTS.md`
   matches the principles' "Short Version".
3. The two copies of each skill stay byte-identical, and `AGENTS.md` lists
   every skill.
4. `AGENTS.md` points only at paths that exist.
5. Every harness file is public, like the rest of the repository: no private
   context, client data or internal paths (`public-repository`).

## Origin, and what was left out

The harness is adapted from the one in Literally.dev's private website
repository. Kept and adapted: the engineering principles (rewritten around
the engine's layers, its method and its evidence), the TypeScript style
guide, `git-operations`, `eslint-suppressions`, and the three review skills.

New here, because they are the engine's own risks: `public-repository`,
`measurement-stability`, `evidence-honesty`, `untrusted-input`,
`tests-cost-nothing`.

Not ported, because they do not apply to a Node engine with no UI and no
private data: the Next.js, Tailwind, Storybook, design token, image and SEO
rules, the company-context protocol, the TODO and playbook protocols, and
the content skill (`humanize`).

Agent permission files (`.claude/settings.local.json`, `.codex/config.toml`,
`.codex/rules/default.rules`) are maintained by the maintainers, not by
agents.
