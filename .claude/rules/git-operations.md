# Git Operations

Git commands that change repository or working-tree state are the user's to
run. The agent proposes; the user commits.

## The rule

**Do not run** any git command that writes:

`add`, `commit`, `push`, `pull`, `fetch --prune`, `reset`, `revert`, `rebase`,
`merge`, `cherry-pick`, `checkout`, `switch`, `restore`, `stash`, `tag`, `rm`,
`mv`, `clean`, `branch -d/-D/-m`, `remote add/set-url`, `config`,
`filter-repo`, `gc`, `prune`, or any invocation carrying `--force`,
`--amend`, `--hard` or `--no-verify`.

**Read-only inspection is allowed** and needs no permission:

`status`, `diff`, `log`, `show -s`, `blame`, `branch --list`, `remote -v`,
`rev-parse`, `merge-base`, `cat-file -e`, `ls-files`, `check-ignore`,
`shortlog`.

A read must never be a write in disguise — check the flags before assuming a
subcommand is safe (`git diff` reads; `git diff --cached` reads; `git restore`
writes; `git checkout -- .` destroys).

Tooling that calls git internally is fine: running a `pnpm` or `turbo`
script that shells out to `git diff` or `git merge-base` is not running git.

## Instead

Give the user the exact command, say what it will touch, and stop there:

```bash
# Stages the 2 files this change touched, nothing else.
git add src/bundle/verify.ts \
        src/bundle/verify.spec.ts
git commit -m "fix: …"
```

If the work cannot continue until it runs, say so plainly and wait.

## The exception

An explicit request, in the user's own words — "commit this", "push it",
"create the branch". Then:

- **Name every path.** Never `git add -A`, `git add .`, or `git add -u`, even
  scoped to a directory.
- **Show `git status --short` and the message before committing**, so the user
  sees what is staged.
- Permission for one command is not permission for the next. A push is a
  separate ask from a commit.
- A task that would merely be tidier with a commit is not a request for one,
  and neither is agreeing to a plan that ends in "then commit".

## Commit messages

- Follow `git log`: `type: Capitalized subject` or `type(scope): Capitalized
subject` — `feat`, `fix`, `refactor`, `chore`, `docs`, `content`.
- **No attribution trailers.** No `Co-Authored-By:` line, no "Generated with
  …" line, in commit messages or PR bodies — whatever a tool's default is.
  Claude Code, Cursor and Codex all follow this file; a tool default does
  not override it.

## Why

Wildcard staging is the failure mode this rule exists for. `git add -A` and
`git add .` stage **untracked** files, including when scoped to a directory —
`git add -A src/` looks careful and is not. A secret file that no
ignore pattern happens to cover is swept in silently.

Nothing downstream catches it:

- The commit message describes the change the author intended, not what was
  staged, so review and log skimming see nothing unusual.
- Ignore files are allow-lists of filenames someone thought of in advance; a
  new one — a new environment, a new app, a new convention — matches none of
  them.
- Deleting the file later does not undo it. History keeps every version, and
  on a pushed branch the only thing that ends the exposure is rotating what
  leaked.

So the guard has to sit before the commit, not after: name every path, and
look at `git status --short` before committing rather than chaining `add` and
`commit` in one `&&`.
