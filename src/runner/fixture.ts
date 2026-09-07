import type { Finding, Runner, ScopedTools, WorkerEvent, WorkerSpec } from '../types.js';

const MARKER = /STATION-DEFECT:([a-z0-9-]+)/;

function seedFindings(spec: WorkerSpec): Finding[] {
  const findings: Finding[] = [];
  for (const item of spec.packet.manifest.items) {
    if (item.path === '__diff__.patch' || item.side !== 'head') continue;
    const lines = item.content.split('\n');
    for (const [offset, line] of lines.entries()) {
      const marked = line.match(MARKER);
      if (!marked) continue;
      const quote = line
        .replace(/\/\/.*$/, '')
        .trim()
        .replace(/[,;]$/, '');
      findings.push({
        id: marked[1],
        title: `Seeded defect ${marked[1]}`,
        body: `Fixture reviewer recovered the planned defect ${marked[1]} from the captured head excerpt.`,
        severity: 'high',
        path: item.path,
        side: 'head',
        startLine: item.startLine + offset,
        endLine: item.startLine + offset,
        evidence: [{ contextItemId: item.id, quote: quote || marked[1] }],
        disposition: 'pending',
      });
    }
  }
  return findings;
}

export class FixtureRunner implements Runner {
  async *run(
    spec: WorkerSpec,
    tools: ScopedTools,
    signal: AbortSignal,
  ): AsyncIterable<WorkerEvent> {
    signal.throwIfAborted();
    yield {
      type: 'metadata',
      version: 'fixture/1',
      model: 'Seeded-corpus fixture · no model calls',
    };
    if (spec.role === 'verifier') {
      for (const finding of spec.findings)
        for (const evidence of finding.evidence)
          await tools.read({
            itemId: evidence.contextItemId,
            reason: 'Verify seeded evidence against the captured excerpt.',
          });
      yield {
        type: 'result',
        findings: spec.findings.map((finding) => ({
          ...finding,
          disposition: finding.disposition === 'rejected' ? 'rejected' : 'supported',
          verification:
            finding.verification ??
            'Fixture check: evidence is an exact substring of the captured item.',
        })),
      };
      return;
    }
    const findings = seedFindings(spec);
    for (const finding of findings)
      await tools.read({
        itemId: finding.evidence[0].contextItemId,
        reason: `Inspect seeded defect ${finding.id}.`,
      });
    yield { type: 'result', findings };
  }
}
