# Frozen held-out dataset

Pinned 10 September 2026, before any evaluation run.

| File | Role |
| --- | --- |
| `benchmark.dataset.json` | 25 defect cases + 12 clean controls |
| `benchmark.dataset.sha256` | SHA-256 of that JSON (`c030412aa0a98126a5a867fc581d795cda4835b5ba65601a02903fb7d4d53c86`) |

`repoPath` values are relative to this directory (`repos/<owner>-<name>`). Clones are gitignored; restore them with:

```sh
pnpm cli dataset-fetch --dataset artifacts/benchmark.dataset.json --cache artifacts/repos
```

Defect cases are conventional `fix:` commits (or merges that closed a `bug`-labelled PR). The tree under review is the fix commit's parent; labels are source lines that fix replaced. Typo, locale-copy, type/noop, and export/types-only fixes are omitted.

Clean cases are source-only refactors, renames, type-only edits, or perf changes with zero labels. Docs, lockfiles, and assets are excluded. Files-changed medians: defect 6, clean 5. Clean dates span 2017–2026 so class is not collinear with the 2026-05 cutoff (9 of 25 defects are post-cutoff). The JSON `summary` records both distributions.

Do not edit the JSON after freeze. If the miner is re-run, treat that as a new dataset and hash it again before evaluation.
