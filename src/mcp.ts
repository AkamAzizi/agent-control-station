import { stdin, stdout } from 'node:process';
import { compileReviewContext } from './compile.js';

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS = [
  {
    name: 'compile_review_context',
    description:
      'Compile a scoped, immutable review packet from a local Git repository. Returns excerpt ids, provenance, limitations, and the reviewer prompt. No model call is made.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repo: { type: 'string', description: 'Absolute path to a local Git checkout.' },
        base: { type: 'string', description: 'Base Git ref or commit.' },
        head: { type: 'string', description: 'Head Git ref or commit. Defaults to HEAD.' },
        task: { type: 'string', description: 'Review task in plain language.' },
        scopePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional path prefixes that bound analysis.',
        },
      },
      required: ['repo', 'base'],
    },
  },
];

function writeMessage(message: JsonRpc) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  stdout.write(body);
}

function summarizePacket(packet: Awaited<ReturnType<typeof compileReviewContext>>['packet']) {
  return {
    id: packet.id,
    status: packet.status,
    byteLength: packet.byteLength,
    estimatedTokens: packet.estimatedTokens,
    compilerVersion: packet.manifest.compilerVersion,
    items: packet.manifest.items.map((item) => ({
      id: item.id,
      path: item.path,
      side: item.side,
      startLine: item.startLine,
      endLine: item.endLine,
      reason: item.reason,
    })),
    omitted: packet.manifest.omitted,
    limitations: packet.manifest.limitations,
    prompt: packet.prompt,
  };
}

export async function handleMcpRequest(request: JsonRpc, directory?: string): Promise<JsonRpc> {
  const id = request.id ?? null;
  try {
    if (request.method === 'initialize')
      return {
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-control-station', version: '0.1.0' },
        },
      };
    if (request.method === 'notifications/initialized' || request.method === 'initialized')
      return { id: null };
    if (request.method === 'ping') return { id, result: {} };
    if (request.method === 'tools/list') return { id, result: { tools: TOOLS } };
    if (request.method === 'tools/call') {
      const name = String(request.params?.name ?? '');
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      if (name !== 'compile_review_context') throw new Error(`Unknown tool: ${name}`);
      const repo = String(args.repo ?? '');
      const base = String(args.base ?? '');
      if (!repo || !base) throw new Error('repo and base are required');
      const compiled = await compileReviewContext({
        repo,
        base,
        head: args.head ? String(args.head) : undefined,
        task: args.task ? String(args.task) : undefined,
        scopePaths: Array.isArray(args.scopePaths)
          ? args.scopePaths.map((value) => String(value))
          : undefined,
        directory,
      });
      const summary = summarizePacket(compiled.packet);
      return {
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
          structuredContent: summary,
        },
      };
    }
    if (request.method === 'resources/list') return { id, result: { resources: [] } };
    throw new Error(`Unsupported method: ${request.method}`);
  } catch (error) {
    return {
      id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function serveMcp(directory?: string) {
  let buffer = Buffer.alloc(0);
  stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    void drain();
  });
  async function drain() {
    while (buffer.length) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd >= 0) {
        const header = buffer.subarray(0, headerEnd).toString('utf8');
        const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
        if (!Number.isFinite(length)) break;
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        const body = buffer.subarray(start, start + length).toString('utf8');
        buffer = buffer.subarray(start + length);
        const response = await handleMcpRequest(JSON.parse(body) as JsonRpc, directory);
        if (response.id !== null && response.id !== undefined) writeMessage(response);
        continue;
      }
      const text = buffer.toString('utf8');
      const newline = text.indexOf('\n');
      if (newline < 0 || !text.trimStart().startsWith('{')) return;
      const line = text.slice(0, newline).trim();
      buffer = Buffer.from(text.slice(newline + 1), 'utf8');
      if (!line) continue;
      const response = await handleMcpRequest(JSON.parse(line) as JsonRpc, directory);
      if (response.id !== null && response.id !== undefined) writeMessage(response);
    }
  }
}
