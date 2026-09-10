# Frozen held-out dataset

Pinned 10 September 2026, before any evaluation run.

| File | Role |
| --- | --- |
| `benchmark.dataset.json` | 25 defect cases + 12 clean controls |
| `benchmark.dataset.sha256` | SHA-256 of that JSON (`830ae460782d0907d26ce0ee0c8e025debdac63c8297f4c384ab0068258a3df7`) |

`repoPath` values are relative to this directory (`repos/<owner>-<name>`). Clones are gitignored; restore them with:

```sh
pnpm cli dataset-fetch --dataset artifacts/benchmark.dataset.json --cache artifacts/repos
```

Defect cases are conventional `fix:` commits (or merges that closed a `bug`-labelled PR). The tree under review is the fix commit's parent; labels are source lines that fix replaced. Clean cases are docs-only, formatting-only, or dependency-bump commits with zero labels.

Do not edit the JSON after freeze. If the miner is re-run, treat that as a new dataset and hash it again before evaluation.
