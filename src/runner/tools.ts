import type { ContextPacket, Finding, ScopedTools } from '../types.js';
import { acceptFindings } from './review-result.js';
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
  return acceptFindings(findings, packet, previous);
}
