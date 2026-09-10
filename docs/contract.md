# Shared implementation contract

The shared TypeScript domain is `src/types.ts`. Keep domain changes synchronized between the context compiler, runtime, daemon and browser.

## Repository and context interfaces

`src/repository/index.ts`: export async `snapshot(repoPath: string, base: string, head: string): Promise<Snapshot>` and `validateRepository(repoPath: string): Promise<{path: string; name: string}>`.

`src/context/index.ts`: export `compile(snapshot: Snapshot, task: string, policy?: Partial<ContextPolicy>, packs?: JudgmentPack[], scopePaths?: string[]): ContextPacket` (sync or Promise accepted; caller awaits it). Git diff must use the merge-base. Snapshot sources are immutable Git contents, never the working tree. Context hashes exclude time and local absolute paths. Use deterministic local analysis, explicit reasons, and scope-bound item IDs. Rule packs are data, not executable code.

## Browser interface

Use relative `/api` paths, same origin. JSON errors: `{error:string}`. No fake client-side run data. Empty state includes an explicit "Try demo" action. English product UI. Operator model credentials are server environment variables, never requested in browser.

- GET `/api/state` → `{repos:RepositoryRecord[], runs:Run[], packs:JudgmentPack[], settings:{maxWorkers:4}, models:{provider:string,id:string,name:string}[], modelError?:string}`
- POST `/api/repos` `{path}` → RepositoryRecord
- POST `/api/runs` ReviewRequest → Run (202)
- GET `/api/runs/:id` → `{run:Run, context:ContextPacket|null, events:RunEvent[], feedback:Feedback[]}`
- POST `/api/runs/:id/cancel` → Run
- POST `/api/runs/:id/retry` → Run (202)
- GET `/api/runs/:id/export?format=markdown|json` → download
- POST `/api/runs/:id/feedback` `{findingId,verdict,note}` → Feedback
- POST `/api/runs/:id/pack-draft` `{findingId}` → inactive JudgmentPack derived from the latest explanatory feedback
- GET `/api/context/:id` → ContextPacket, including verifier-specific manifests referenced by durable events
- POST `/api/packs` JudgmentPack → JudgmentPack (same id must increment version)
- POST `/api/demo` `{}` → `{repo:RepositoryRecord,run:Run}`; explicit deterministic scripted demo, no paid model calls
- GET `/api/events` SSE `event: station`, JSON RunEvent, durable numeric ID; replay Last-Event-ID
- POST `/api/github/import` `{repoId,url}` → `{base:string,head:string,title:string}`; optional installed gh, read-only GitHub, fetches only local Git objects

`pnpm cli mcp` exposes `compile_review_context` over MCP stdio (Content-Length JSON-RPC). Cursor/Claude Code can request a scoped packet without a model call.

`pnpm cli corpus --out DIR` writes three original seeded-defect Git repositories plus `dataset.json`. Labels include `path` and `quote` so fixture scoring can auto-assess blinded `*.assessment.json` files.

`pnpm cli dataset-mine` clones public TypeScript/JavaScript repositories, emits held-out defect and clean-control cases, and freezes `artifacts/benchmark.dataset.json` with a SHA-256 sidecar. `kind: clean` cases have zero labels; a finding on those rows is a false positive. Fetch clones later with `pnpm cli dataset-fetch`.

`STATION_CASSETTE=record|replay` and `STATION_CASSETTE_FILE` wrap provider `fetch` in the Pi worker. Replay refuses unmatched live HTTP.

Tests use node:test via `tsx --test test/*.test.ts` and exercise behavior through public interfaces. The Pi adapter runs in a child process with a controlled ResourceLoader and an explicit read-only tool allowlist. Child tool requests are enforced and recorded in the daemon; disconnecting the daemon stops the child.
