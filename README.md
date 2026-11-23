# mend — one patch tool for every AI edit format

An entry for the make.fun bounty
[hidden-spec-cli-01](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
a dependency-free Node 22 CLI that applies the edits AI models write — unified
diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON
tool calls — to a tree of text files, exactly as `SPEC.md` specifies.

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/btcrugpul/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/btcrugpul/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

## How it works

- Lines are matched at the first of three tiers that finds them: exact, then
  trailing-whitespace-insensitive, then fully trimmed — with section 5's
  re-indentation of new lines at the loosest tier (`--strict` keeps tier 0 only).
- Unified hunks take the occurrence nearest the stated line number, adjusted
  by the drift of the hunks before them, and `\ No newline` marks are honoured.
- SEARCH/REPLACE blocks must match exactly once; V4A chunks walk a cursor
  through the file, with anchors and end-of-file chunks.
- Every edit is all-or-nothing: a failed edit changes nothing, and when any
  edit fails, no file is written at all.

## Files

- `main.ts` — the CLI, run as `node main.ts [options] [PATCH]`; `runner.ts`
  beside it runs it over a trial's checks when `MAKEFUN_ENV_URL` is set.
- `SPEC.md` — the specification the CLI implements.
- `check.ts` — runs `main.ts` over the public practice set.

Practice set: 100 of 100 checks pass.
