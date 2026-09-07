import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { snapshot } from './repository/index.js';
import { compile } from './context/index.js';
import { packSchema, resultSchema } from './schemas.js';
import {
  DEFAULT_POLICY,
  type ContextPacket,
  type Snapshot,
  type Finding,
  type Usage,
  type Runner,
} from './types.js';
import { PiRunner } from './runner/pi.js';
import { FixtureRunner } from './runner/fixture.js';
import { scopedTools } from './runner/tools.js';
import { acceptFindings } from './runner/review-result.js';
import { renderBenchmarkGraph } from './benchmark-graph.js';

const datasetSchema = z.object({
  cases: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_-]+$/),
        repoPath: z.string(),
        base: z.string(),
        head: z.string(),
        task: z.string(),
        labels: z.array(
          z.object({
            id: z.string(),
            description: z.string(),
            path: z.string().optional(),
            quote: z.string().optional(),
          }),
        ),
        packs: z.array(packSchema).default([]),
      }),
    )
    .min(1),
});
export type Variant = 'baseline' | 'context' | 'packs';
type BenchResult = {
  id: string;
  caseId: string;
  variant: Variant;
  repeat: number;
  labels: { id: string; description: string }[];
  contextId: string;
  revisions: { base: string; head: string; mergeBase: string };
  findings: Finding[];
  usage: Usage;
  compileMs: number;
  totalMs: number;
  error?: string;
};

export function baselinePacket(source: Snapshot, reference: ContextPacket): ContextPacket {
  const items = Object.entries(source.sources).flatMap(([side, files]) =>
    Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => ({
        id: createHash('sha256').update(`${source.id}:${side}:${path}`).digest('hex').slice(0, 24),
        path,
        side: side as 'base' | 'head',
        startLine: 1,
        endLine: Math.max(1, content.split('\n').length),
        content,
        reason: 'baseline repository access',
      })),
  );
  const manifest = {
    ...reference.manifest,
    items,
    packs: [],
    omitted: [],
    limitations: [
      ...source.limitations,
      'Benchmark baseline: full allowed snapshot file access; no code excerpts upfront.',
    ],
  };
  const prompt = `${reference.manifest.task}\n\nDiff:\n${source.diff}\n\nAvailable files (use read_context with itemId):\n${items.map((i) => `${i.id} ${i.side}:${i.path}`).join('\n')}`;
  const id = createHash('sha256').update(JSON.stringify({ manifest, prompt })).digest('hex');
  return {
    id,
    manifest,
    prompt,
    byteLength: Buffer.byteLength(prompt),
    estimatedTokens: Math.ceil(Buffer.byteLength(prompt) / 4),
    symbols: reference.symbols,
    status: source.diff.trim() ? 'ready' : 'needs_input',
  };
}

export function assessAgainstLabels(
  findings: Finding[],
  labels: { id: string; description: string; path?: string; quote?: string }[],
) {
  const seeded = labels.some((label) => label.path || label.quote);
  const used = new Set<string>();
  return findings
    .filter((finding) => finding.disposition === 'supported')
    .map((finding) => {
      const match = labels.find((label) => {
        if (used.has(label.id)) return false;
        if (label.path && label.path !== finding.path) return false;
        if (
          label.quote &&
          !finding.evidence.some(
            (evidence) =>
              evidence.quote.includes(label.quote!) || label.quote!.includes(evidence.quote),
          )
        )
          return false;
        return Boolean(label.path || label.quote);
      });
      if (match) {
        used.add(match.id);
        return {
          findingId: finding.id,
          title: finding.title,
          body: finding.body,
          path: finding.path,
          startLine: finding.startLine,
          matchedLabelId: match.id,
          verdict: 'accepted' as const,
        };
      }
      return {
        findingId: finding.id,
        title: finding.title,
        body: finding.body,
        path: finding.path,
        startLine: finding.startLine,
        matchedLabelId: null,
        verdict: seeded ? ('rejected' as const) : ('unassessed' as const),
      };
    });
}

export async function benchmark(options: {
  dataset: string;
  directory: string;
  provider?: string;
  model?: string;
  runtime?: 'pi' | 'fixture';
  repeats: number;
  execute: boolean;
}) {
  const dataset = datasetSchema.parse(JSON.parse(await readFile(options.dataset, 'utf8')));
  if (new Set(dataset.cases.map((c) => c.id)).size !== dataset.cases.length)
    throw new Error('Dataset case ids must be unique.');
  for (const sample of dataset.cases)
    if (new Set(sample.labels.map((label) => label.id)).size !== sample.labels.length)
      throw new Error(`Duplicate labels in ${sample.id}`);
  if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 10)
    throw new Error('Repeats must be 1–10');
  const runtime = options.runtime ?? 'pi';
  const plan = {
    cases: dataset.cases.length,
    variants: 3,
    repeats: options.repeats,
    runtime,
    maxWorkerCalls: dataset.cases.length * 3 * options.repeats * 2,
    provider: options.provider,
    model: options.model,
  };
  if (!options.execute) {
    console.log(
      JSON.stringify(
        {
          ...plan,
          status: 'dry-run',
          next:
            runtime === 'fixture'
              ? 'Add --execute to run the fixture reviewer on the seeded corpus (no model calls).'
              : 'Add --execute to make paid model calls. Use disjoint pack-training and evaluation cases.',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (runtime === 'pi' && (!options.provider || !options.model))
    throw new Error('Explicit --provider and --model are required for Pi.');
  await mkdir(options.directory, { recursive: true });
  if ((await readdir(options.directory)).length)
    throw new Error('Output directory must be empty; choose a new directory.');
  await writeFile(join(options.directory, 'plan.json'), JSON.stringify(plan, null, 2));
  const runner: Runner =
    runtime === 'fixture' ? new FixtureRunner() : new PiRunner(options.directory);
  const root = dirname(options.dataset);
  for (const sample of dataset.cases) {
    const source = await snapshot(resolve(root, sample.repoPath), sample.base, sample.head);
    for (let repeat = 1; repeat <= options.repeats; repeat++)
      for (const variant of ['baseline', 'context', 'packs'] as const) {
        const start = performance.now();
        const compilation = performance.now();
        let packet = await compile(
          source,
          sample.task,
          {},
          variant === 'packs' ? sample.packs.filter((p) => p.roles.includes('reviewer')) : [],
        );
        if (variant === 'baseline') packet = baselinePacket(source, packet);
        const result: BenchResult = {
          id: randomUUID(),
          caseId: sample.id,
          variant,
          repeat,
          labels: sample.labels,
          contextId: packet.id,
          revisions: { base: source.base, head: source.head, mergeBase: source.mergeBase },
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, readBytes: 0, cost: null },
          compileMs: performance.now() - compilation,
          totalMs: 0,
        };
        const traces: Record<string, unknown>[] = [];
        try {
          if (packet.status !== 'ready')
            throw new Error('Context exceeds budget or has no reviewable scope');
          for (const role of ['reviewer', 'verifier'] as const) {
            if (role === 'verifier' && !result.findings.length) break;
            if (role === 'verifier' && variant === 'packs')
              packet = await compile(
                source,
                sample.task,
                {},
                sample.packs.filter((p) => p.roles.includes('verifier')),
              );
            await writeFile(
              join(options.directory, `${result.id}.${role}.context.json`),
              JSON.stringify(packet, null, 2),
            );
            if (packet.status !== 'ready') throw new Error(`${role} context is not reviewable`);
            const signal = AbortSignal.timeout(DEFAULT_POLICY.timeoutMs);
            const tools = scopedTools(packet, DEFAULT_POLICY.maxToolCalls, signal, (event) => {
              traces.push({ role, ...event });
              result.usage.readBytes += Number(event.bytes ?? 0);
            });
            let completed = false;
            for await (const event of runner.run(
              {
                runId: result.id,
                role,
                packet,
                findings: result.findings,
                request: {
                  repoId: sample.id,
                  base: source.mergeBase,
                  head: source.head,
                  task: sample.task,
                  runtime: runtime === 'fixture' ? 'scripted' : 'pi',
                  provider: options.provider,
                  model: options.model,
                },
                policy: DEFAULT_POLICY,
              },
              tools,
              signal,
            )) {
              if (event.type === 'usage') {
                result.usage.toolCalls += event.usage.toolCalls ?? 0;
                result.usage.inputTokens += event.usage.inputTokens ?? 0;
                result.usage.outputTokens += event.usage.outputTokens ?? 0;
                if (event.usage.cost != null)
                  result.usage.cost = (result.usage.cost ?? 0) + event.usage.cost;
              }
              if (event.type === 'result') {
                const value = resultSchema.parse(event);
                result.findings = acceptFindings(
                  value.findings,
                  packet,
                  role === 'verifier' ? result.findings : undefined,
                );
                completed = true;
                if (value.incomplete) throw new Error(value.incomplete);
              }
            }
            if (!completed) throw new Error('Worker did not complete');
          }
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
        }
        result.totalMs = performance.now() - start;
        await writeFile(
          join(options.directory, `${result.id}.result.json`),
          JSON.stringify(result, null, 2),
        );
        await writeFile(
          join(options.directory, `${result.id}.trace.json`),
          JSON.stringify(traces, null, 2),
        );
        // Blind files omit variant/runtime. Seeded labels with path+quote are auto-assessed.
        await writeFile(
          join(options.directory, `${result.id}.assessment.json`),
          JSON.stringify(
            {
              id: result.id,
              caseId: sample.id,
              expected: sample.labels,
              findings: assessAgainstLabels(result.findings, sample.labels),
            },
            null,
            2,
          ),
        );
        console.log(
          `${sample.id} ${variant} ${repeat}/${options.repeats}: ${result.error ?? 'completed'}`,
        );
      }
  }
  await scoreBenchmark(options.directory);
}

export async function scoreBenchmark(directory: string) {
  const names = (await readdir(directory)).filter((f) => f.endsWith('.result.json'));
  const results: BenchResult[] = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))),
  );
  if (!results.length) throw new Error('No benchmark results found.');
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length
      ? sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : null;
  };
  const summaries = [];
  for (const variant of ['baseline', 'context', 'packs'] as const) {
    const rows = results.filter((r) => r.variant === variant);
    let tp = 0,
      fp = 0,
      fn = 0,
      unassessed = 0;
    for (const result of rows) {
      if (result.error) continue;
      const assessment = JSON.parse(
        await readFile(join(directory, `${result.id}.assessment.json`), 'utf8'),
      ) as { findings: { findingId: string; matchedLabelId: string | null; verdict: string }[] };
      const found = new Set<string>();
      for (const finding of result.findings.filter((f) => f.disposition === 'supported')) {
        const review = assessment.findings.find((f) => f.findingId === finding.id);
        if (
          review?.verdict === 'accepted' &&
          review.matchedLabelId &&
          result.labels.some((l) => l.id === review.matchedLabelId) &&
          !found.has(review.matchedLabelId)
        ) {
          tp++;
          found.add(review.matchedLabelId);
        } else if (
          review?.verdict === 'rejected' ||
          (review?.verdict === 'accepted' && found.has(review.matchedLabelId ?? ''))
        )
          fp++;
        else unassessed++;
      }
      fn += result.labels.length - found.size;
    }
    summaries.push({
      variant,
      runs: rows.length,
      failures: rows.filter((r) => r.error).length,
      unassessed,
      precision: unassessed ? null : tp + fp ? tp / (tp + fp) : null,
      recall: unassessed ? null : tp + fn ? tp / (tp + fn) : null,
      medianExplorationBytes: median(rows.map((r) => r.usage.readBytes)),
      medianEstimatedExplorationTokens: median(rows.map((r) => Math.ceil(r.usage.readBytes / 4))),
      medianTotalTokens: median(rows.map((r) => r.usage.inputTokens + r.usage.outputTokens)),
      medianTotalMs: median(rows.map((r) => r.totalMs)),
      medianCompileMs: median(rows.map((r) => r.compileMs)),
    });
  }
  const report = {
    status: summaries.some((s) => s.unassessed || s.failures || !s.runs)
      ? 'incomplete'
      : 'assessed',
    note: 'Exploration tokens are byte/4 estimates. Seeded path+quote labels can be auto-assessed; otherwise humans set blinded *.assessment.json verdicts. A small corpus is not a general model-quality claim.',
    summaries,
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(directory, 'report.svg'), renderBenchmarkGraph(report));
  console.log(JSON.stringify(report, null, 2));
  return report;
}
