# Frozen held-out dataset

Pinned 10 September 2026, before any evaluation run.

| File | Role |
| --- | --- |
| `benchmark.dataset.json` | 23 defect cases + 12 clean controls |
| `benchmark.dataset.sha256` | SHA-256 of that JSON (`1fa16b237f938220d4da9df691c0661e4c25b4c7085a85e239ad598c45e4d0f9`) |

`repoPath` values are relative to this directory (`repos/<owner>-<name>`). Clones are gitignored; restore them with:

```sh
pnpm cli dataset-fetch --dataset artifacts/benchmark.dataset.json --cache artifacts/repos
```

Defect cases are conventional `fix:` commits (or merges that closed a `bug`-labelled PR). The tree under review is the fix commit's parent; labels are source lines that fix replaced. Typo, locale-copy, type/noop, and export/types-only fixes are omitted. After freeze, `graphql-graphql-js-defect-51bad915` and `cheeriojs-cheerio-defect-e48f0224` were removed as weak oracles before any evaluation run; post-cutoff defect cases drop from 9 to 8.

Clean cases are source-only refactors, renames, type-only edits, or perf changes with zero labels. Docs, lockfiles, and assets are excluded. Files-changed medians: defect 6, clean 5. Clean dates span 2017–2026 so class is not collinear with the 2026-05 cutoff (8 of 23 defects are post-cutoff). The JSON `summary` records both distributions.

Do not edit the JSON after freeze. If the miner is re-run, treat that as a new dataset and hash it again before evaluation.
