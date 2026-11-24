# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ASEP9929/makefun-hidden-spec-cli-01-r2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ASEP9929/makefun-hidden-spec-cli-01-r2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)

An entry for [make.fun bounty hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122): build mend, one patch tool for every AI edit format.

`main.ts` is mend: a CLI that applies the edits AI models write, in four formats, to a tree of files. Node 22 and its standard library alone; run it as `node main.ts [options] [PATCH]`. `SPEC.md` is the whole specification.

## What it does

- Reads a patch as a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON edits, detected automatically or named with `--format=`.
- Finds the lines each edit names at the first of three matching tiers (exact, then trailing whitespace ignored, then leading and trailing whitespace ignored, with re-indentation at the third tier); `--strict` tries the exact tier only.
- Writes every change or none: a failed edit changes nothing and the edits after it still run, so every failure is reported. `--check` prints the same output and exit code without writing anything.
- Prints what it changed (`A`/`D`/`M`/`R` lines, then `ok: <n> file(s)`) or why it failed (`error: <code> <path>` lines, then `failed: <k> of <n> edits`).

## The files

- `main.ts`: the CLI. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Practice score

100 of 100 passed on the public practice set: unified 30/30, search_replace 20/20, v4a 20/20, json 15/15, cli 15/15 — practice score 1000.
