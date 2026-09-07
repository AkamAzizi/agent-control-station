# Fixture benchmark snapshot

Generated with:

```sh
pnpm cli corpus --out /tmp/station-corpus
pnpm cli benchmark --dataset /tmp/station-corpus/dataset.json --runtime fixture --repeats 1 --execute --out /tmp/station-bench
```

This measures the station harness (snapshot, context variants, evidence scoring) using the fixture reviewer. It is not a model evaluation. See `report.json` and `report.svg`.
