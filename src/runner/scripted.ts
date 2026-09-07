import type { Runner, WorkerSpec, ScopedTools, WorkerEvent, Finding } from '../types.js';
import { setTimeout as delay } from 'node:timers/promises';
export class ScriptedRunner implements Runner {
  async *run(
    spec: WorkerSpec,
    tools: ScopedTools,
    signal: AbortSignal,
  ): AsyncIterable<WorkerEvent> {
    yield { type: 'metadata', version: 'scripted/1', model: 'Deterministic demo · no model calls' };
    yield {
      type: 'text',
      text:
        spec.role === 'reviewer'
          ? 'Inspecting the immutable demonstration diff.'
          : 'Checking the demonstration finding against its evidence.',
    };
    await delay(120, undefined, { signal });
    if (spec.role === 'verifier') {
      for (const f of spec.findings)
        for (const e of f.evidence)
          await tools.read({
            itemId: e.contextItemId,
            reason: 'Verify the reported condition against the captured code.',
          });
      yield {
        type: 'result',
        findings: spec.findings.map((f) => ({
          ...f,
          disposition: 'supported',
          verification: 'Scripted demo check: the changed condition accepts a negative quantity.',
        })),
      };
      return;
    }
    const item = spec.packet.manifest.items.find(
      (i) =>
        i.path !== '__diff__.patch' && i.side === 'head' && i.content.includes('quantity === 0'),
    );
    const findings: Finding[] = [];
    if (item) {
      await tools.read({
        itemId: item.id,
        reason: 'Inspect the changed quantity validation in the demo.',
      });
      const startLine =
        item.startLine + item.content.split('\n').findIndex((l) => l.includes('quantity === 0'));
      findings.push({
        id: 'demo-negative-quantity',
        title: 'Negative quantities pass validation',
        body: 'The new equality check rejects zero but accepts negative quantities. A request for −1 item reaches pricing and produces a negative order total. Keep rejecting quantities less than or equal to zero.',
        severity: 'high',
        path: item.path,
        side: 'head',
        startLine,
        endLine: startLine,
        evidence: [{ contextItemId: item.id, quote: 'quantity === 0' }],
        disposition: 'pending',
      });
    }
    yield {
      type: 'result',
      findings,
      incomplete: spec.request.demo
        ? undefined
        : 'Scripted mode is a plumbing demonstration, not an AI review. Select Pi to review real changes.',
    };
  }
}
