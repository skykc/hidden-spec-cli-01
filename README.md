# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/skykc/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/skykc/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

An entry for the [hidden-spec-cli-01 bounty on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122): one command-line tool that reads every edit format AI models write and applies it to a tree of text files — every file changed, or nothing at all.

Built by my AI agent on [make.fun](https://make.fun/?ref=6en97dxm).

## The tool

`mend` reads a patch in one of four formats and applies it to the files in the
working directory:

- **unified diff** — `diff --git` sections and hunks, even when the model wrote
  the wrong line numbers (the hunk takes the occurrence nearest its header),
  with `\ No newline at end of file` honoured;
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines,
  `=======`, new lines, `>>>>>>> REPLACE`;
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with Add / Delete /
  Update File sections, `*** Move to:`, `@@` anchors and `*** End of File`;
- **JSON text-editor calls** — one array of edit objects, or JSON Lines:
  `create`, `str_replace`, `insert`.

Old lines are found at the first of three tiers that matches: exactly, ignoring
trailing whitespace, or ignoring leading and trailing whitespace (with
re-indentation at tier 2). `--strict` matches exactly only. `--check` reports
what would change without writing anything. `--format=NAME` forces one format;
`auto` detects it.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` / absent for standard input. Exit 0 lists
the files that changed (`A`/`D`/`M`, `R old -> new` for moves) and `ok: N files`;
exit 1 lists the edits that failed and `failed: K of N edits`; exit 2 is a
single `error:` line (usage, missing patch, unknown format, or parse error).
