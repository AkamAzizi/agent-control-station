import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeCorpus } from '../src/corpus.js';
import { benchmark, scoreBenchmark } from '../src/benchmark.js';
import { compileReviewContext } from '../src/compile.js';
import { handleMcpRequest } from '../src/mcp.js';

test('seeded corpus compiles and fixture benchmark scores all three variants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-corpus-'));
  try {
    const corpus = await materializeCorpus(join(dir, 'corpus'));
    assert.equal(corpus.dataset.cases.length, 3);
    const compiled = await compileReviewContext({
      repo: corpus.dataset.cases[0].repoPath,
      base: corpus.dataset.cases[0].base,
      head: corpus.dataset.cases[0].head,
      task: corpus.dataset.cases[0].task,
      directory: join(dir, 'data'),
    });
    assert.equal(compiled.packet.status, 'ready');
    const out = join(dir, 'bench');
    await benchmark({
      dataset: join(corpus.directory, 'dataset.json'),
      directory: out,
      runtime: 'fixture',
      repeats: 1,
      execute: true,
    });
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    assert.equal(report.status, 'assessed');
    for (const variant of ['baseline', 'context', 'packs']) {
      const row = report.summaries.find(
        (summary: { variant: string }) => summary.variant === variant,
      );
      assert.equal(row.failures, 0);
      assert.equal(row.precision, 1);
      assert.equal(row.recall, 1);
    }
    const scored = await scoreBenchmark(out);
    assert.equal(scored.status, 'assessed');
    assert.match(await readFile(join(out, 'report.svg'), 'utf8'), /exploration/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP compile_review_context returns a scoped packet without a model call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-mcp-'));
  try {
    const corpus = await materializeCorpus(join(dir, 'corpus'));
    const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(
      (listed.result as { tools: { name: string }[] }).tools[0].name,
      'compile_review_context',
    );
    const sample = corpus.dataset.cases[1];
    const called = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'compile_review_context',
          arguments: {
            repo: sample.repoPath,
            base: sample.base,
            head: sample.head,
            task: sample.task,
          },
        },
      },
      join(dir, 'data'),
    );
    const text = (called.result as { content: { text: string }[] }).content[0].text;
    const packet = JSON.parse(text);
    assert.equal(packet.status, 'ready');
    assert.ok(packet.items.some((item: { path: string }) => item.path === 'src/auth.ts'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
