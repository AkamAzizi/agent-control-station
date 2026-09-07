import { resultSchema } from '../schemas.js';
import type { ContextPacket, Finding } from '../types.js';

const SCOPE_REJECT = 'Finding location is outside the compiled snapshot scope.';
const EVIDENCE_REJECT = 'Evidence quote is not an exact substring of the cited context item.';

export class ReviewPayloadError extends Error {}

function hasFindings(value: unknown): value is { findings: unknown } {
  return Boolean(
    value && typeof value === 'object' && Array.isArray((value as { findings?: unknown }).findings),
  );
}

export function extractReviewPayload(source: unknown): unknown | undefined {
  if (
    hasFindings(source) ||
    (source &&
      typeof source === 'object' &&
      typeof (source as { json?: unknown }).json === 'string')
  )
    return source;
  if (typeof source !== 'string') return undefined;
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], source];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (
        hasFindings(parsed) ||
        (parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { json?: unknown }).json === 'string')
      )
        return parsed;
    } catch {
      /* keep scanning */
    }
  }
  return undefined;
}

export function parseReviewResult(source: unknown) {
  const payload = extractReviewPayload(source);
  if (!payload) throw new ReviewPayloadError('No structured review payload');
  const record = payload as { findings?: unknown; json?: string };
  const raw = Array.isArray(record.findings)
    ? payload
    : typeof record.json === 'string'
      ? JSON.parse(record.json)
      : payload;
  try {
    return resultSchema.parse(raw);
  } catch (error) {
    throw new ReviewPayloadError(error instanceof Error ? error.message : 'Invalid review schema');
  }
}

function locationItem(finding: Finding, packet: ContextPacket) {
  return packet.manifest.items.find(
    (item) =>
      item.path !== '__diff__.patch' &&
      item.path === finding.path &&
      item.side === finding.side &&
      finding.startLine >= item.startLine &&
      finding.endLine <= item.endLine,
  );
}

function evidenceProblems(finding: Finding, packet: ContextPacket): string[] {
  const problems: string[] = [];
  if (!locationItem(finding, packet)) problems.push(SCOPE_REJECT);
  for (const evidence of finding.evidence) {
    const item = packet.manifest.items.find((candidate) => candidate.id === evidence.contextItemId);
    if (!item || !item.content.includes(evidence.quote)) problems.push(EVIDENCE_REJECT);
  }
  return problems;
}

function sameFindingFields(left: Finding, right: Finding): boolean {
  for (const key of [
    'title',
    'body',
    'severity',
    'path',
    'side',
    'startLine',
    'endLine',
    'evidence',
  ] as const)
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false;
  return true;
}

export function acceptFindings(
  findings: Finding[],
  packet: ContextPacket,
  previous?: Finding[],
): Finding[] {
  const seen = new Set<string>();
  const accepted: Finding[] = [];
  for (const finding of findings) {
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    let next: Finding = {
      ...finding,
      evidence: finding.evidence.map((evidence) => ({ ...evidence })),
    };
    const reasons: string[] = [];
    if (previous) {
      const original = previous.find((item) => item.id === next.id);
      if (!original) continue;
      if (!sameFindingFields(next, original)) {
        reasons.push('Verifier changed immutable finding fields; original restored.');
        next = { ...original, disposition: next.disposition, verification: next.verification };
      }
      if (next.disposition === 'pending' || !next.verification)
        reasons.push('Verifier must explain a supported, rejected, or uncertain disposition.');
    }
    reasons.push(...evidenceProblems(next, packet));
    if (reasons.length) {
      next.disposition = 'rejected';
      next.verification = [next.verification, ...reasons].filter(Boolean).join(' ');
    } else if (!previous) next.disposition = 'pending';
    accepted.push(next);
  }
  if (previous)
    for (const original of previous)
      if (!accepted.some((item) => item.id === original.id))
        accepted.push({
          ...original,
          disposition: evidenceProblems(original, packet).length ? 'rejected' : 'uncertain',
          verification: evidenceProblems(original, packet).length
            ? evidenceProblems(original, packet).join(' ')
            : 'Verifier omitted this finding.',
        });
  return accepted;
}
