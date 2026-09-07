# Seeded-defect corpus

Original TypeScript fixtures with planned bugs. They are **modeled on public defect classes**, not copies of upstream pull requests.

| Case               | Planned bug                                          | Public pattern                                                                       |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `bounds-check`     | `quantity === 0` accepts negatives                   | [CWE-839](https://cwe.mitre.org/data/definitions/839.html) incomplete numeric bounds |
| `assignment-guard` | `if ((role = 'admin'))` assigns instead of comparing | [ESLint `no-cond-assign`](https://eslint.org/docs/latest/rules/no-cond-assign)       |
| `dropped-await`    | async `loadUser` used without `await`                | [CWE-758](https://cwe.mitre.org/data/definitions/758.html) control-flow mistakes     |

Ground truth is the `labels[].path` and `labels[].quote` fields. Marker comments `// STATION-DEFECT:<id>` sit on the defective line so the fixture reviewer can recover them without a model.

```sh
pnpm cli corpus --out /tmp/station-corpus
pnpm cli benchmark --dataset /tmp/station-corpus/dataset.json --runtime fixture --repeats 1 --execute --out /tmp/station-bench
```

The fixture runtime makes no provider calls. Precision/recall here measure whether the harness recovered the seeded quotes, not model quality. Use `--runtime pi` plus `--provider` / `--model` (or a recorded cassette) when you want a paid experiment.
