import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { scopedTools, validateFindings } from '../src/runner/tools.js';
import { PiRunner } from '../src/runner/pi.js';
import { createDemo } from '../src/demo.js';
import {
  DEFAULT_POLICY,
  type ContextPacket,
  type JudgmentPack,
  type Runner,
  type WorkerEvent,
} from '../src/types.js';

const packet: ContextPacket = {
  id: 'a'.repeat(64),
  status: 'ready',
  prompt: 'test',
  byteLength: 4,
  estimatedTokens: 1,
  symbols: [],
  manifest: {
    version: 1,
    snapshotId: 'b'.repeat(64),
    compilerVersion: 'test',
    policy: DEFAULT_POLICY,
    task: 'review',
    packs: [],
    omitted: [],
    limitations: [],
    items: [
      {
        id: 'allowed',
        path: 'src/a.ts',
        side: 'head',
        startLine: 1,
        endLine: 1,
        content: 'export const value = 1;',
        reason: 'changed_symbol',
      },
    ],
  },
};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for state');
}

test('scoped tools audit exact reads and deny unknown IDs, traversal and excess calls', async () => {
  const events: Record<string, unknown>[] = [];
  const tools = scopedTools(packet, 3, new AbortController().signal, (e) => events.push(e));
  const value = await tools.read({ itemId: 'allowed', reason: 'Check changed value' });
  value.content = 'mutated';
  assert.equal(packet.manifest.items[0].content, 'export const value = 1;');
  assert.equal(events[0].path, 'src/a.ts');
  assert.equal(events[0].bytes, 23);
  await assert.rejects(tools.read({ itemId: '../../.env', reason: 'attempt' }), /outside/);
  await tools.lookup({ name: 'missing', reason: 'Resolve name' });
  await assert.rejects(tools.read({ itemId: 'allowed', reason: 'again' }), /budget/);
});

test('finding evidence must exist at the claimed immutable location', () => {
  const finding = {
    id: 'f',
    title: 'x',
    body: 'x',
    severity: 'high' as const,
    path: 'src/a.ts',
    side: 'head' as const,
    startLine: 1,
    endLine: 1,
    evidence: [{ contextItemId: 'allowed', quote: 'value = 1' }],
    disposition: 'pending' as const,
  };
  assert.equal(validateFindings([finding], packet).length, 1);
  assert.throws(() => validateFindings([{ ...finding, path: 'other.ts' }], packet), /outside/);
  assert.throws(
    () =>
      validateFindings(
        [{ ...finding, evidence: [{ contextItemId: 'allowed', quote: 'invented' }] }],
        packet,
      ),
    /ungrounded/,
  );
});

test('operator completes a demo, inspects provenance, gives feedback, exports and reopens it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-flow-'));
  let server = await createServer({ directory: dir, models: [] });
  try {
    const response = await server.app.inject({ method: 'POST', url: '/api/demo', payload: {} });
    assert.equal(response.statusCode, 200, response.body);
    const { repo, run } = response.json();
    await server.orchestrator.idle();
    const detail = (await server.app.inject(`/api/runs/${run.id}`)).json();
    assert.equal(detail.run.status, 'completed', JSON.stringify(detail.run));
    assert.equal(detail.run.findings[0].disposition, 'supported');
    assert.equal(detail.run.usage.cost, null);
    assert.equal(detail.run.request.demo, true);
    assert.ok(detail.events.some((e: any) => e.type === 'tool.read' && e.data.reason));
    assert.ok(detail.context.id);
    const feedback = await server.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/feedback`,
      payload: {
        findingId: detail.run.findings[0].id,
        verdict: 'useful',
        note: 'Expected regression',
      },
    });
    assert.equal(feedback.statusCode, 200);
    const draft = await server.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/pack-draft`,
      payload: { findingId: detail.run.findings[0].id },
    });
    assert.equal(draft.statusCode, 200, draft.body);
    assert.equal(draft.json().active, false);
    assert.equal(draft.json().rules[0].text, 'Expected regression');
    const markdown = await server.app.inject(`/api/runs/${run.id}/export?format=markdown`);
    assert.match(markdown.body, /Scripted demonstration/);
    assert.match(markdown.body, /Negative quantities/);
    assert.match(markdown.body, /Expected regression/);
    const pack: JudgmentPack = {
      id: 'quantity',
      name: 'Quantity bounds',
      version: 1,
      active: false,
      globs: ['src/**/*.ts'],
      roles: ['reviewer'],
      rules: [{ id: 'positive', text: 'Check negative inputs as well as zero.' }],
    };
    assert.equal(
      (await server.app.inject({ method: 'POST', url: '/api/packs', payload: pack })).statusCode,
      200,
    );
    assert.equal(
      (await server.app.inject({ method: 'POST', url: '/api/packs', payload: pack })).statusCode,
      400,
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/packs',
          payload: { ...pack, version: 2, active: true },
        })
      ).statusCode,
      200,
    );
    const retry = (
      await server.app.inject({ method: 'POST', url: `/api/runs/${run.id}/retry`, payload: {} })
    ).json();
    await server.orchestrator.idle();
    assert.equal(
      server.store.run(retry.id).contextId,
      detail.run.contextId,
      'Retry preserves original pack snapshot and commits',
    );
    await server.app.close();
    server = await createServer({ directory: dir, models: [] });
    assert.equal(server.store.run(run.id).status, 'completed');
    assert.equal(server.store.feedback(run.id).length, 1);
    assert.equal(server.store.repo(repo.id).path, repo.path);
  } finally {
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('server rejects cross-site writes and forged hosts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-origin-'));
  const { app } = await createServer({ directory: dir, models: [] });
  try {
    assert.equal(
      (await app.inject({ url: '/api/state', headers: { host: 'attacker.example' } })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/demo',
          headers: { origin: 'https://attacker.example' },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/demo',
          headers: { 'content-type': 'text/plain' },
          payload: '{}',
        })
      ).statusCode,
      415,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('queue has four active workers and cancellation releases a slot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-queue-'));
  const demo = await createDemo(dir);
  const store = new Store(dir);
  let active = 0,
    maximum = 0;
  const runner: Runner = {
    async *run(_spec, _tools, signal): AsyncIterable<WorkerEvent> {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await delay(100000, undefined, { signal });
        yield { type: 'result', findings: [] };
      } finally {
        active--;
      }
    },
  };
  const orchestration = new Orchestrator(store, { runner });
  try {
    const repo = await orchestration.register(demo.path);
    const runs = Array.from({ length: 5 }, () =>
      orchestration.start({
        repoId: repo.id,
        base: demo.base,
        head: demo.head,
        task: 'Review',
        runtime: 'scripted',
      }),
    );
    await until(() => active === 4);
    assert.equal(store.run(runs[4].id).status, 'queued');
    orchestration.cancel(runs[0].id);
    await until(
      () =>
        store.run(runs[0].id).status === 'cancelled' && store.run(runs[4].id).status === 'running',
    );
    assert.equal(maximum, 4);
    for (const run of runs) orchestration.cancel(run.id);
    await orchestration.idle();
    assert.equal(active, 0);
  } finally {
    await orchestration.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('daemon recovery marks an unfinished attempt interrupted and preserves its events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-recovery-'));
  let store = new Store(dir);
  const demo = await createDemo(dir);
  let orchestration = new Orchestrator(store);
  const repo = await orchestration.register(demo.path);
  const run = orchestration.start({
    repoId: repo.id,
    base: demo.base,
    head: demo.head,
    task: 'Review',
    runtime: 'scripted',
  });
  await orchestration.close();
  run.status = 'running';
  run.nodes[0].status = 'running';
  store.record(run, 'step.started', { step: 'snapshot' });
  store.close();
  store = new Store(dir);
  orchestration = new Orchestrator(store);
  try {
    assert.equal(store.run(run.id).status, 'interrupted');
    assert.equal(store.run(run.id).nodes[0].status, 'interrupted');
    assert.ok(store.events(0, run.id).some((e) => e.type === 'run.interrupted'));
    const last = store.events().at(-1)!.id;
    assert.deepEqual(store.events(last), []);
  } finally {
    await orchestration.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Pi subprocess fails explicitly for an unknown model without making a paid call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-pi-'));
  const runner = new PiRunner(dir);
  const signal = AbortSignal.timeout(15000);
  const tools = scopedTools(packet, 3, signal, () => {});
  try {
    await assert.rejects(async () => {
      for await (const _ of runner.run(
        {
          runId: 'test',
          role: 'reviewer',
          packet,
          findings: [],
          request: {
            repoId: 'test',
            base: 'a',
            head: 'b',
            task: 'test',
            runtime: 'pi',
            provider: 'not-a-provider',
            model: 'not-a-model',
          },
          policy: DEFAULT_POLICY,
        },
        tools,
        signal,
      )) {
      }
    }, /Selected model is unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
