import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Store } from './store.js';
import { snapshot, validateRepository } from './repository/index.js';
import { compile } from './context/index.js';
import {
  DEFAULT_POLICY,
  type Run,
  type ReviewRequest,
  type RunEvent,
  type StepName,
  type Runner,
  type ContextPacket,
  type Snapshot,
  type Finding,
} from './types.js';
import { requestSchema, resultSchema } from './schemas.js';
import { ContextMissing, scopedTools, validateFindings } from './runner/tools.js';
import { ScriptedRunner } from './runner/scripted.js';
import { PiRunner } from './runner/pi.js';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'needs_input']);
export class Orchestrator {
  readonly events = new EventEmitter();
  private active = new Map<string, AbortController>();
  private promises = new Set<Promise<void>>();
  private stopped = false;
  constructor(
    readonly store: Store,
    private options: { maxWorkers?: number; runner?: Runner } = {},
  ) {
    for (const run of store.runs())
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.error = 'Daemon stopped before this attempt completed.';
        for (const node of run.nodes)
          if (node.status === 'running') {
            node.status = 'interrupted';
            node.error = run.error;
          }
        for (const node of run.nodes) if (node.status === 'queued') node.status = 'skipped';
        store.record(run, 'run.interrupted', { error: run.error });
      }
    queueMicrotask(() => this.drain());
  }
  async register(path: string) {
    const repo = await validateRepository(path);
    return this.store.addRepo(repo.path, repo.name);
  }
  start(input: ReviewRequest, previousRunId?: string): Run {
    const request = requestSchema.parse(input);
    const repo = this.store.repo(request.repoId);
    const previous = previousRunId ? this.store.run(previousRunId) : undefined;
    const time = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      title: request.task.split('\n')[0].slice(0, 100),
      repoId: repo.id,
      repoName: repo.name,
      request,
      status: 'queued',
      createdAt: time,
      updatedAt: time,
      attempt: (previous?.attempt ?? 0) + 1,
      previousRunId,
      nodes: (['snapshot', 'context', 'review', 'verify', 'result'] as StepName[]).map((name) => ({
        name,
        status: 'queued',
      })),
      findings: [],
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, readBytes: 0, cost: null },
      limitations: [],
      packSnapshot: previous?.packSnapshot ?? this.store.packs(),
      snapshotId: previous?.snapshotId,
    };
    this.record(run, 'run.queued', { runtime: request.runtime, attempt: run.attempt });
    queueMicrotask(() => this.drain());
    return run;
  }
  retry(id: string) {
    const prev = this.store.run(id);
    if (!terminal.has(prev.status))
      throw new Error('Cancel or finish the current run before retrying.');
    return this.start(prev.request, id);
  }
  cancel(id: string) {
    const run = this.store.run(id);
    if (terminal.has(run.status)) return run;
    const active = this.active.get(id);
    if (active) {
      active.abort(new Error('Cancelled by operator'));
      return { ...run, status: 'cancelled' as const };
    }
    run.status = 'cancelled';
    for (const node of run.nodes) if (node.status === 'queued') node.status = 'skipped';
    this.record(run, 'run.cancelled');
    return run;
  }
  private record(run: Run, type: string, data: Record<string, unknown> = {}) {
    const event = this.store.record(run, type, data);
    this.events.emit('event', event);
  }
  private drain() {
    if (this.stopped) return;
    for (const run of this.store.runs().reverse()) {
      if (this.active.size >= (this.options.maxWorkers ?? 4)) break;
      if (run.status !== 'queued' || this.active.has(run.id)) continue;
      const controller = new AbortController();
      this.active.set(run.id, controller);
      const promise = this.execute(run, controller.signal).finally(() => {
        this.active.delete(run.id);
        this.promises.delete(promise);
        this.drain();
      });
      this.promises.add(promise);
    }
  }
  private async execute(run: Run, signal: AbortSignal) {
    let current: StepName = 'snapshot';
    const step = async <T>(name: StepName, fn: () => Promise<T> | T): Promise<T> => {
      signal.throwIfAborted();
      current = name;
      const node = run.nodes.find((n) => n.name === name)!;
      node.status = 'running';
      node.startedAt = new Date().toISOString();
      this.record(run, 'step.started', { step: name });
      const value = await fn();
      signal.throwIfAborted();
      node.status = 'completed';
      node.finishedAt = new Date().toISOString();
      this.record(run, 'step.completed', { step: name });
      return value;
    };
    try {
      run.status = 'running';
      this.record(run, 'run.started');
      const source = await step('snapshot', async () => {
        const old = run.snapshotId
          ? (this.store.artifact('snapshot', run.snapshotId) as Snapshot | null)
          : null;
        const value =
          old ??
          (await snapshot(this.store.repo(run.repoId).path, run.request.base, run.request.head));
        run.snapshotId = value.id;
        run.request = { ...run.request, base: value.mergeBase, head: value.head };
        this.store.artifact('snapshot', value.id, value);
        return value;
      });
      const policy = { ...DEFAULT_POLICY, ...run.request.policy };
      const packet = await step('context', async () => {
        const value = await compile(
          source,
          run.request.task,
          policy,
          (run.packSnapshot ?? []).filter((p) => p.roles.includes('reviewer')),
          run.request.scopePaths,
        );
        this.store.artifact('context', value.id, value);
        run.contextId = value.id;
        run.limitations = value.manifest.limitations;
        this.record(run, 'context.compiled', {
          role: 'reviewer',
          contextId: value.id,
          bytes: value.byteLength,
          items: value.manifest.items.length,
        });
        if (value.status === 'needs_input')
          throw new ContextMissing(
            'The selected context is not reviewable. Inspect coverage limitations, then start a new review with adjusted scope or budget.',
          );
        return value;
      });
      const runner =
        this.options.runner ??
        (run.request.runtime === 'pi' ? new PiRunner(this.store.directory) : new ScriptedRunner());
      const work = async (
        role: 'reviewer' | 'verifier',
        context: ContextPacket,
        findings: Finding[],
      ) => {
        const timeout = AbortSignal.timeout(policy.timeoutMs);
        const workerSignal = AbortSignal.any([signal, timeout]);
        let toolProblem: string | undefined;
        const rawTools = scopedTools(context, policy.maxToolCalls, workerSignal, (data) => {
          if (run.request.runtime !== 'pi') run.usage.toolCalls++;
          run.usage.readBytes += Number(data.bytes ?? 0);
          this.record(run, 'tool.read', { ...data, role });
        });
        const tools = {
          read: async (input: Parameters<typeof rawTools.read>[0]) => {
            try {
              return await rawTools.read(input);
            } catch (e) {
              toolProblem = String(e);
              throw e;
            }
          },
          lookup: async (input: Parameters<typeof rawTools.lookup>[0]) => {
            try {
              return await rawTools.lookup(input);
            } catch (e) {
              toolProblem = String(e);
              throw e;
            }
          },
        };
        let result: Finding[] | undefined;
        let pendingText = '';
        let textFlushedAt = Date.now();
        const flushText = () => {
          if (pendingText) {
            this.record(run, 'worker.text', { role, text: pendingText });
            pendingText = '';
            textFlushedAt = Date.now();
          }
        };
        for await (const event of runner.run(
          { runId: run.id, role, packet: context, findings, request: run.request, policy },
          tools,
          workerSignal,
        )) {
          workerSignal.throwIfAborted();
          if (event.type === 'metadata') {
            run.runtimeVersion = event.version;
            run.model = event.model;
            this.record(run, 'worker.metadata', { role, ...event });
          }
          if (event.type === 'text') {
            pendingText += event.text;
            if (pendingText.length >= 2000 || Date.now() - textFlushedAt >= 250) flushText();
          }
          if (event.type === 'usage') {
            run.usage.toolCalls += event.usage.toolCalls ?? 0;
            run.usage.inputTokens += event.usage.inputTokens ?? 0;
            run.usage.outputTokens += event.usage.outputTokens ?? 0;
            if (event.usage.cost != null) run.usage.cost = (run.usage.cost ?? 0) + event.usage.cost;
            this.record(run, 'worker.usage', { role, ...event.usage });
          }
          if (event.type === 'result') {
            flushText();
            const parsed = resultSchema.parse(event);
            result = validateFindings(
              parsed.findings,
              context,
              role === 'verifier' ? findings : undefined,
            );
            if (role === 'reviewer') result = result.map((f) => ({ ...f, disposition: 'pending' }));
            if (parsed.incomplete) {
              run.findings = result;
              throw new ContextMissing(parsed.incomplete);
            }
          }
        }
        flushText();
        if (toolProblem) throw new ContextMissing(toolProblem);
        if (!result) throw new Error('Worker exited without a structured result');
        return result;
      };
      run.findings = await step('review', () => work('reviewer', packet, []));
      if (run.findings.length) {
        run.findings = await step('verify', async () => {
          const verifier = await compile(
            source,
            run.request.task,
            policy,
            (run.packSnapshot ?? []).filter((p) => p.roles.includes('verifier')),
            run.request.scopePaths,
          );
          this.store.artifact('context', verifier.id, verifier);
          this.record(run, 'context.compiled', {
            role: 'verifier',
            contextId: verifier.id,
            bytes: verifier.byteLength,
          });
          if (verifier.status !== 'ready')
            throw new ContextMissing('Verifier context does not fit the budget.');
          return work('verifier', verifier, run.findings);
        });
      } else run.nodes.find((n) => n.name === 'verify')!.status = 'skipped';
      await step('result', () => {
        run.findings.sort(
          (a, b) =>
            a.path.localeCompare(b.path) || a.startLine - b.startLine || a.id.localeCompare(b.id),
        );
      });
      run.status = 'completed';
      this.record(run, 'run.completed', { findings: run.findings.length });
    } catch (error) {
      run.status = signal.aborted
        ? this.stopped
          ? 'interrupted'
          : 'cancelled'
        : error instanceof ContextMissing
          ? 'needs_input'
          : 'failed';
      run.error = error instanceof Error ? error.message : String(error);
      const node = run.nodes.find((n) => n.name === current)!;
      node.status = run.status;
      node.error = run.error;
      node.finishedAt = new Date().toISOString();
      for (const remaining of run.nodes)
        if (remaining.status === 'queued') remaining.status = 'skipped';
      this.record(run, `run.${run.status}`, { step: current, error: run.error });
    }
  }
  async idle() {
    while (this.promises.size || this.store.runs().some((r) => r.status === 'queued')) {
      this.drain();
      await Promise.all(this.promises);
    }
  }
  async close() {
    this.stopped = true;
    for (const control of this.active.values()) control.abort(new Error('Daemon shutdown'));
    await Promise.all(this.promises);
  }
  subscribe(listener: (event: RunEvent) => void) {
    this.events.on('event', listener);
    return () => {
      this.events.off('event', listener);
    };
  }
}
