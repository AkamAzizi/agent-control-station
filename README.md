# Agent Control Station

A local control station for scoped coding-agent reviews, with deterministic upfront context and an auditable record of every code read.

This pilot supports TypeScript/JavaScript repositories, four concurrent review workers, local feedback and Markdown/JSON exports. Pi runs make requests to the selected model provider. The explicitly labelled demo is deterministic and makes no model calls.

## Run locally

Requirements: Node.js 24 or newer, Git, and pnpm (the repository pins pnpm 12.3.4).

```sh
pnpm install
pnpm build
pnpm start
```

Open [127.0.0.1:4317](http://127.0.0.1:4317). Choose **Try demo** for a complete, no-cost example. It creates a small local Git repository, reviews a seeded quantity-validation change, and produces a clearly labelled scripted finding.

For a real review, provide a model-provider API key in the daemon's environment, restart it, register an existing local repository, and select **Pi** plus an available model. Supported environment variables include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, and `XAI_API_KEY`. Keep credentials out of source files and browser forms. The application does not load a project `.env` file or automatically reuse a Claude Code/Codex subscription.

Select base/head Git refs, describe the review task, and queue the run. Optional GitHub PR import uses the installed and signed-in `gh` CLI to read metadata and fetch local objects; it does not publish reviews. GitHub.com is supported by the pilot importer.

Data lives in `.station/`, which is ignored by Git. Override with `STATION_DATA` or `pnpm cli serve --data /absolute/path --port 4317`. History and source excerpts are stored locally; source context for Pi runs is sent to the selected provider. Local access assumes a single trusted operator.

## What a run does

1. Pin the repository's Git revisions and compute their merge-base diff.
2. Compile immutable source excerpts and a manifest explaining why each excerpt was selected.
3. Run a specialized reviewer with only scoped read/lookup tools.
4. Run a fresh finding verifier against the original findings and captured evidence.
5. Save all dispositions, usage, read traces, operator feedback and exportable results.

Each worker has a ten-minute deadline and a forty-tool-call ceiling. The upfront context default is 96 KiB, including at most 8 KiB of matching judgment packs. Token counts for context size and exploration are estimates; provider-reported usage is recorded separately. Unknown cost is displayed as unavailable.

Cancellation releases a worker slot. An interrupted daemon marks unfinished attempts as interrupted. Retry creates a new attempt using the original Git snapshot and captured pack versions, even if branches or active packs have since changed. To change scope or budget, create a new review.

Model output is not deterministic. Context selection is: the same Git inputs, task, compiler/policy version and packs produce the same packet identity. Dynamic runtime behavior and external dependency internals cannot be fully established through static analysis; coverage limitations remain visible in the run.

## Inspect context without a model

```sh
pnpm cli context --repo /absolute/repository --base main --head feature-branch --out /tmp/review-context
```

This writes `context.json` and `context.md` into the explicit output directory. Exit code 2 means the required context does not fit or no reviewable scope was selected. Output includes excerpt IDs, source positions, provenance, omissions and the compiler version. No model credentials are needed.

## Judgment packs

Create packs in the **Judgment packs** view. Matching is based on path globs and reviewer/verifier roles. Packs hold local evaluation criteria and historical examples; current code facts always come from the Git snapshot.

Feedback with an explanatory note can create an inactive draft. Review its wording and scope before activating a new version. Pack versions are immutable and a run captures the versions it was started with. Automatic learning and automatic promotion are intentionally outside this pilot.

Saved packs also have Markdown representations in `.station/packs/`. The JSON frontmatter is the editable structured source; the body is a rendered view. To import an edited pack, increment `version` and run:

```sh
pnpm cli pack-import --file /absolute/path/pack.md
```

## Evaluate quality and exploration

Copy `examples/benchmark.dataset.json` and supply real repository paths, immutable refs, task descriptions and independently identified expected defects. Keep pack-training PRs separate from evaluation PRs. Start with at least twenty held-out PRs and three repeats for each variant.

```sh
pnpm cli benchmark --dataset /absolute/dataset.json --provider PROVIDER --model MODEL --out /tmp/station-benchmark
```

The default is a dry run that reports the number of potential model calls. Add `--execute` to run the paid experiment. Benchmark output directories must be fresh so previous results are not overwritten.

The three variants share worker roles, model settings and call limits: diff plus full allowed snapshot access; compiled context; compiled context plus judgment packs. The baseline uses the same harness read protocol, with all eligible snapshot files available, rather than a stock Pi CLI session.

After execution, review the blinded `*.assessment.json` files. Set each finding's verdict to `accepted` with a valid `matchedLabelId`, or `rejected`. Leave unknowns as `unassessed`. Then run:

```sh
pnpm cli benchmark-score --out /tmp/station-benchmark
```

`report.json` includes precision/recall, failures, unassessed findings, exploration-byte/token estimates, total model tokens, compilation time and total time. Raw traces and all verifier dispositions remain available. The pilot target is a 25% reduction in median exploration with no measured precision/recall regression. No effectiveness claim is made before independent assessments and a sufficiently representative dataset exist.

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` watches the daemon. For UI development, additionally run `pnpm --filter @agent-station/web dev`; Vite proxies `/api` to port 4317.

Tests use temporary Git repositories and the scripted runner to verify deterministic snapshots, context selection, scope enforcement, evidence grounding, queue limits, cancellation, recovery, feedback, export and persistence. The Pi subprocess failure path is tested without paid model calls. A successful provider-backed review and the historical benchmark require the operator's provider credentials and dataset.

The module interfaces are documented in `docs/contract.md`. Backend source is under `src/`, the browser app under `apps/web/`, and tests under `test/`.

## Pilot limits

- Single operator and loopback-only daemon; no multi-user auth or hosted deployment.
- Reviews and exports are local; coding changes and GitHub publication are not implemented.
- Pi is the real runtime adapter; Claude Code is a future adapter.
- Reviewers have no shell or write tools. Worker process separation is lifecycle isolation, not an OS security sandbox.
- Only captured, allowed Git content participates in a run. Uncommitted changes are excluded.
- Static dependency selection follows direct calls and repository path aliases. External package internals, dynamic dispatch, and most tsconfig compiler options are not modeled. Explicit scope paths also exclude dependencies and tests outside those paths.
- Snapshot compilation currently reads eligible Git blobs individually; very large monorepositories need batching and performance validation before rollout.
- Schema version 1 is created transactionally. Future database upgrades must add a backup step before migration; newer unknown schemas are refused.
