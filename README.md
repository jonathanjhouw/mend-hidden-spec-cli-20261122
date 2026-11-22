# mend-hidden-spec-cli-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jonathanjhouw/mend-hidden-spec-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jonathanjhouw/mend-hidden-spec-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one Node 22 CLI that applies all four edit formats AI models write — unified diffs with drifted line numbers, SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON — to a tree of text files, changing every file or none. It matches lines at three whitespace tiers, handles CRLF and final-newline rules, and reports exactly the paths that changed. The full contract is `SPEC.md`.

## Run it

```sh
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

With `MAKEFUN_ENV_URL` set, the kit's `runner.ts` answers every check in the live env. Locally:

```sh
node check.ts tests/practice.json
```

`tests/focused.json` holds regression cases for the matching tiers and each format. The public practice set reports 100 of 100 passed.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jonathanjhouw&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
