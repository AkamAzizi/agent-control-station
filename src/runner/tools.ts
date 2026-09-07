import type { ContextPacket, Finding, ScopedTools } from '../types.js';
export class ContextMissing extends Error {}
export function scopedTools(
  packet: ContextPacket,
  limit: number,
  signal: AbortSignal,
  record: (data: Record<string, unknown>) => void,
): ScopedTools {
  let count = 0;
  const items = new Map(packet.manifest.items.map((item) => [item.id, item]));
  function check(reason: string) {
    signal.throwIfAborted();
    if (++count > limit) throw new ContextMissing('Worker tool budget exceeded');
    if (!reason?.trim()) throw new Error('A read reason is required');
  }
  return {
    async read({ itemId, reason }) {
      check(reason);
      const item = items.get(itemId);
      if (!item) {
        record({ tool: 'read_context', itemId, reason, denied: true, bytes: 0 });
        throw new ContextMissing('Requested code is outside the compiled context scope');
      }
      record({
        tool: 'read_context',
        itemId,
        reason,
        path: item.path,
        side: item.side,
        startLine: item.startLine,
        endLine: item.endLine,
        bytes: Buffer.byteLength(item.content),
        selectionReason: item.reason,
      });
      return structuredClone(item);
    },
    async lookup({ name, reason }) {
      check(reason);
      const symbols = packet.symbols.filter(
        (s) =>
          s.name === name &&
          packet.manifest.items.some(
            (i) =>
              i.path === s.path &&
              i.side === s.side &&
              i.startLine <= s.startLine &&
              i.endLine >= s.endLine,
          ),
      );
      record({
        tool: 'lookup_symbol',
        name,
        reason,
        bytes: Buffer.byteLength(JSON.stringify(symbols)),
        matches: symbols.length,
      });
      return structuredClone(symbols);
    },
  };
}
export function validateFindings(
  findings: Finding[],
  packet: ContextPacket,
  previous?: Finding[],
): Finding[] {
  const ids = new Set<string>();
  for (const f of findings) {
    if (ids.has(f.id)) throw new Error('Duplicate finding identifier');
    ids.add(f.id);
    const location = packet.manifest.items.find(
      (i) =>
        i.path !== '__diff__.patch' &&
        i.path === f.path &&
        i.side === f.side &&
        f.startLine >= i.startLine &&
        f.endLine <= i.endLine,
    );
    if (!location) throw new Error(`Finding ${f.id} cites a location outside its snapshot scope`);
    for (const evidence of f.evidence) {
      const item = packet.manifest.items.find((i) => i.id === evidence.contextItemId);
      if (!item || !item.content.includes(evidence.quote))
        throw new Error(`Finding ${f.id} has ungrounded evidence`);
    }
    if (previous) {
      const original = previous.find((p) => p.id === f.id);
      if (!original) throw new Error('Verifier invented a finding');
      if (f.disposition === 'pending' || !f.verification)
        throw new Error('Verifier must explain a disposition');
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
        if (JSON.stringify(f[key]) !== JSON.stringify(original[key]))
          throw new Error(
            'Verifier must preserve the original finding and only update its disposition and verification.',
          );
    }
  }
  if (previous && previous.some((p) => !ids.has(p.id)))
    throw new Error('Verifier omitted a finding');
  return findings;
}
