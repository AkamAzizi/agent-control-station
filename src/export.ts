import type { Run, ContextPacket, Feedback } from './types.js';
export function exportMarkdown(
  run: Run,
  context: ContextPacket | null,
  feedback: Feedback[],
): string {
  const lines = [
    `# ${run.title}`,
    '',
    `Status: ${run.status} · Runtime: ${run.model ?? run.request.runtime} · Attempt: ${run.attempt}`,
    '',
    `Repository: ${run.repoName}`,
    `Base: ${run.request.base}`,
    `Head: ${run.request.head}`,
    `Context: ${run.contextId ?? 'not compiled'}`,
    '',
  ];
  if (run.request.runtime === 'scripted')
    lines.push('> Scripted demonstration. This is not an AI review.', '');
  if (run.error) lines.push(`Incomplete/error: ${run.error}`, '');
  if (!run.findings.length)
    lines.push(
      run.status === 'completed'
        ? 'No findings within the reviewed scope.'
        : 'No completed review findings.',
      '',
    );
  for (const f of run.findings) {
    lines.push(
      `## [${f.severity}] ${f.title}`,
      '',
      `${f.path}:${f.startLine} (${f.side}) · ${f.disposition}`,
      '',
      f.body,
      '',
      f.verification ?? '',
      '',
    );
    for (const e of f.evidence)
      lines.push(`Evidence ${e.contextItemId}:`, '', '```', e.quote, '```', '');
  }
  lines.push(
    '## Context coverage',
    '',
    ...(context?.manifest.limitations ?? run.limitations).map((l) => `- ${l}`),
    '',
    `Included excerpts: ${context?.manifest.items.length ?? 0}`,
    `Omitted: ${context?.manifest.omitted.length ?? 0}`,
    `Exploration bytes: ${run.usage.readBytes}`,
    `Input/output tokens: ${run.usage.inputTokens}/${run.usage.outputTokens}`,
    `Reported cost: ${run.usage.cost === null ? 'unavailable' : run.usage.cost}`,
    '',
  );
  if (feedback.length)
    lines.push(
      '## Operator feedback',
      '',
      ...feedback.map((f) => `- ${f.findingId}: ${f.verdict}${f.note ? ` — ${f.note}` : ''}`),
      '',
    );
  return lines.join('\n');
}
