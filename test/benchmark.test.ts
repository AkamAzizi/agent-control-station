import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchmark, scoreBenchmark } from '../src/benchmark.js';

test('benchmark dry run validates input without invoking a model or creating output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-bench-dry-'));
  try {
    const path = join(dir, 'dataset.json');
    await writeFile(
      path,
      JSON.stringify({
        cases: [
          {
            id: 'case',
            repoPath: '/intentionally/missing',
            base: 'main',
            head: 'feature',
            task: 'Review',
            labels: [],
            packs: [],
          },
        ],
      }),
    );
    await benchmark({ dataset: path, directory: join(dir, 'output'), repeats: 3, execute: false });
    await assert.rejects(readFile(join(dir, 'output', 'plan.json')), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('quality metrics require independent assessment and duplicate labels count once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-bench-score-'));
  const finding = {
    id: 'f',
    title: 'Defect',
    body: 'Concrete defect',
    severity: 'high',
    path: 'src/a.ts',
    side: 'head',
    startLine: 1,
    endLine: 1,
    evidence: [],
    disposition: 'supported',
  };
  try {
    await writeFile(
      join(dir, 'run.result.json'),
      JSON.stringify({
        id: 'run',
        caseId: 'case',
        variant: 'context',
        repeat: 1,
        labels: [{ id: 'bug', description: 'Expected bug' }],
        contextId: 'context',
        findings: [finding, { ...finding, id: 'duplicate' }],
        usage: { inputTokens: 100, outputTokens: 10, readBytes: 80, toolCalls: 2, cost: null },
        compileMs: 5,
        totalMs: 100,
      }),
    );
    await writeFile(
      join(dir, 'run.assessment.json'),
      JSON.stringify({
        findings: [
          { findingId: 'f', matchedLabelId: null, verdict: 'unassessed' },
          { findingId: 'duplicate', matchedLabelId: null, verdict: 'unassessed' },
        ],
      }),
    );
    const first = await scoreBenchmark(dir);
    assert.equal(first.status, 'incomplete');
    assert.equal(first.summaries.find((s) => s.variant === 'context')!.precision, null);
    await writeFile(
      join(dir, 'run.assessment.json'),
      JSON.stringify({
        findings: [
          { findingId: 'f', matchedLabelId: 'bug', verdict: 'accepted' },
          { findingId: 'duplicate', matchedLabelId: 'bug', verdict: 'accepted' },
        ],
      }),
    );
    const second = await scoreBenchmark(dir);
    const measured = second.summaries.find((s) => s.variant === 'context')!;
    assert.equal(measured.precision, 0.5);
    assert.equal(measured.recall, 1);
    assert.equal(measured.medianEstimatedExplorationTokens, 20);
    assert.equal(measured.falsePositiveRate, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a finding on a clean case is a false positive and sets the false-positive rate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-bench-clean-'));
  const finding = {
    id: 'spurious',
    title: 'Imagined defect',
    body: 'There is no defect on this docs-only change.',
    severity: 'low',
    path: 'README.md',
    side: 'head',
    startLine: 1,
    endLine: 1,
    evidence: [{ contextItemId: 'item', quote: 'docs' }],
    disposition: 'supported',
  };
  try {
    await writeFile(
      join(dir, 'clean.result.json'),
      JSON.stringify({
        id: 'clean',
        caseId: 'docs-only',
        kind: 'clean',
        variant: 'context',
        repeat: 1,
        labels: [],
        contextId: 'context',
        findings: [finding],
        usage: { inputTokens: 10, outputTokens: 2, readBytes: 40, toolCalls: 1, cost: null },
        compileMs: 1,
        totalMs: 10,
      }),
    );
    await writeFile(
      join(dir, 'clean.assessment.json'),
      JSON.stringify({
        findings: [{ findingId: 'spurious', matchedLabelId: null, verdict: 'rejected' }],
      }),
    );
    await writeFile(
      join(dir, 'quiet.result.json'),
      JSON.stringify({
        id: 'quiet',
        caseId: 'format-only',
        kind: 'clean',
        variant: 'context',
        repeat: 1,
        labels: [],
        contextId: 'context',
        findings: [],
        usage: { inputTokens: 8, outputTokens: 1, readBytes: 20, toolCalls: 1, cost: null },
        compileMs: 1,
        totalMs: 8,
      }),
    );
    await writeFile(join(dir, 'quiet.assessment.json'), JSON.stringify({ findings: [] }));
    const report = await scoreBenchmark(dir);
    const measured = report.summaries.find((s) => s.variant === 'context')!;
    assert.equal(measured.precision, 0);
    assert.equal(measured.recall, null);
    assert.equal(measured.falsePositiveRate, 0.5);
    assert.equal(measured.cleanRuns, 2);
    assert.equal(measured.cleanFalsePositiveRuns, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('benchmark refuses to overwrite existing output before starting workers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-bench-preserve-'));
  try {
    const dataset = join(dir, 'dataset.json');
    const original = JSON.stringify({
      cases: [
        {
          id: 'case',
          repoPath: '/missing',
          base: 'main',
          head: 'HEAD',
          task: 'Review',
          labels: [],
        },
      ],
    });
    await writeFile(dataset, original);
    await assert.rejects(
      benchmark({
        dataset,
        directory: dir,
        repeats: 1,
        execute: true,
        provider: 'unused',
        model: 'unused',
      }),
      /Output directory must be empty/,
    );
    assert.equal(await readFile(dataset, 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
