import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fingerprintRequest,
  installCassette,
  matchExchange,
  type CassetteFile,
} from '../src/runner/cassette.js';

test('cassette replay returns the recorded provider response and refuses unmatched live calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-cassette-'));
  const file = join(dir, 'happy.json');
  const url = 'https://api.example.test/v1/messages';
  const body = JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'review' }] });
  const cassette: CassetteFile = {
    version: 1,
    exchanges: [
      {
        id: fingerprintRequest('POST', url, body),
        method: 'POST',
        url,
        requestBody: body,
        status: 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: JSON.stringify({ ok: true, tool: 'submit_review' }),
      },
    ],
  };
  await writeFile(file, JSON.stringify(cassette));
  const session = await installCassette({ mode: 'replay', file });
  try {
    const matched = await fetch(url, { method: 'POST', body });
    assert.equal(matched.status, 200);
    assert.equal((await matched.json()).tool, 'submit_review');
    await assert.rejects(
      fetch('https://api.example.test/v1/other', { method: 'POST', body: '{}' }),
      /Cassette miss/,
    );
  } finally {
    await session.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cassette matching falls back to method and path when the body hash differs', () => {
  const url = 'https://api.example.test/v1/messages?api-key=secret';
  const cassette: CassetteFile = {
    version: 1,
    exchanges: [
      {
        id: 'old-hash',
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        requestBody: '{"prompt":"v1"}',
        status: 200,
        responseHeaders: {},
        responseBody: '{"ok":true}',
      },
    ],
  };
  const exchange = matchExchange(cassette, 'POST', url, '{"prompt":"v2"}', new Set<number>());
  assert.equal(exchange.responseBody, '{"ok":true}');
});
