# Frozen held-out dataset

`benchmark.dataset.json` is the evaluation set. `benchmark.dataset.sha256` is the SHA-256 of that file, committed before any scoring run.

`repoPath` values are relative to this directory (`repos/<owner>-<name>`). Clones are gitignored; restore them with:

```sh
pnpm cli dataset-fetch --dataset artifacts/benchmark.dataset.json --cache artifacts/repos
```

Do not edit the JSON after freeze. If the miner is re-run, treat that as a new dataset and hash it again before evaluation.
