import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type CassetteMode = 'off' | 'record' | 'replay';

export interface CassetteExchange {
  id: string;
  method: string;
  url: string;
  requestBody: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
}

export interface CassetteFile {
  version: 1;
  recordedAt?: string;
  exchanges: CassetteExchange[];
}

const REDACT = /^(authorization|x-api-key|api-key|cookie|set-cookie|x-goog-api-key)$/i;

export function cassetteMode(value = process.env.STATION_CASSETTE): CassetteMode {
  if (value === 'record' || value === 'replay') return value;
  return 'off';
}

export function fingerprintRequest(method: string, url: string, body: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${parsed.origin}${parsed.pathname}\n${normalizeBody(body)}`)
    .digest('hex')
    .slice(0, 24);
}

function normalizeBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body;
  }
}

export function redactHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  for (const [key, value] of entries)
    result[key] = REDACT.test(key)
      ? '[redacted]'
      : Array.isArray(value)
        ? value.join(', ')
        : String(value);
  return result;
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()])
      if (/key|token|secret|auth/i.test(key)) url.searchParams.set(key, '[redacted]');
    return url.toString();
  } catch {
    return value;
  }
}

function headerMap(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = REDACT.test(key) ? '[redacted]' : value;
  });
  return result;
}

export async function loadCassette(file: string): Promise<CassetteFile> {
  return JSON.parse(await readFile(file, 'utf8')) as CassetteFile;
}

export async function saveCassette(file: string, cassette: CassetteFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cassette, null, 2)}\n`);
}

export function matchExchange(
  cassette: CassetteFile,
  method: string,
  url: string,
  body: string,
  used: Set<number>,
): CassetteExchange {
  const id = fingerprintRequest(method, url, body);
  const exact = cassette.exchanges.findIndex(
    (exchange, index) => exchange.id === id && !used.has(index),
  );
  if (exact >= 0) return cassette.exchanges[exact];
  const parsed = new URL(url);
  parsed.search = '';
  const target = `${parsed.origin}${parsed.pathname}`;
  const sequential = cassette.exchanges.findIndex((exchange, index) => {
    if (used.has(index)) return false;
    try {
      const recorded = new URL(exchange.url);
      recorded.search = '';
      return (
        exchange.method === method.toUpperCase() &&
        `${recorded.origin}${recorded.pathname}` === target
      );
    } catch {
      return false;
    }
  });
  if (sequential >= 0) return cassette.exchanges[sequential];
  throw new Error(
    `Cassette miss for ${method.toUpperCase()} ${sanitizeUrl(url)}. Refusing a live provider call.`,
  );
}

export async function installCassette(options?: {
  mode?: string;
  file?: string;
}): Promise<{ mode: CassetteMode; flush: () => Promise<void> }> {
  const mode = cassetteMode(options?.mode);
  const file = options?.file ?? process.env.STATION_CASSETTE_FILE;
  if (mode === 'off')
    return {
      mode,
      flush: async () => {},
    };
  if (!file) throw new Error('STATION_CASSETTE_FILE is required when recording or replaying.');
  const original = globalThis.fetch.bind(globalThis);
  const used = new Set<number>();
  const recorded: CassetteFile =
    mode === 'replay'
      ? await loadCassette(file)
      : { version: 1, recordedAt: new Date().toISOString(), exchanges: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    if (mode === 'replay') {
      const exchange = matchExchange(recorded, request.method, request.url, body, used);
      used.add(recorded.exchanges.indexOf(exchange));
      return new Response(exchange.responseBody, {
        status: exchange.status,
        headers: exchange.responseHeaders,
      });
    }
    const response = await original(request);
    const responseBody = await response.clone().text();
    recorded.exchanges.push({
      id: fingerprintRequest(request.method, request.url, body),
      method: request.method.toUpperCase(),
      url: sanitizeUrl(request.url),
      requestBody: body,
      status: response.status,
      responseHeaders: headerMap(response.headers),
      responseBody,
    });
    return response;
  }) as typeof fetch;
  return {
    mode,
    flush: async () => {
      globalThis.fetch = original;
      if (mode === 'record') await saveCassette(file, recorded);
    },
  };
}
