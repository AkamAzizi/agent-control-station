import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptFindings,
  extractReviewPayload,
  parseReviewResult,
} from '../src/runner/review-result.js';
import { DEFAULT_POLICY, type ContextPacket, type Finding } from '../src/types.js';

const packet: ContextPacket = {
  id: 'a'.repeat(64),
  status: 'ready',
  prompt: 'test',
  byteLength: 4,
  estimatedTokens: 1,
  symbols: [],
  manifest: {
    version: 1,
    snapshotId: 'b'.repeat(64),
    compilerVersion: 'test',
    policy: DEFAULT_POLICY,
    task: 'review',
    packs: [],
    omitted: [],
    limitations: [],
    items: [
      {
        id: 'allowed',
        path: 'src/a.ts',
        side: 'head',
        startLine: 1,
        endLine: 3,
        content: 'export const value = 1;\nexport const other = 2;',
        reason: 'changed_symbol',
      },
    ],
  },
};

const grounded: Finding = {
  id: 'f1',
  title: 'Unguarded value',
  body: 'value is used without a bound.',
  severity: 'high',
  path: 'src/a.ts',
  side: 'head',
  startLine: 1,
  endLine: 1,
  evidence: [{ contextItemId: 'allowed', quote: 'value = 1' }],
  disposition: 'pending',
};

test('submit_review accepts a structured object and chat JSON, not only a json string field', () => {
  const structured = parseReviewResult({ findings: [grounded] });
  assert.equal(structured.findings[0].id, 'f1');
  const wrapped = parseReviewResult({ json: JSON.stringify({ findings: [grounded] }) });
  assert.equal(wrapped.findings.length, 1);
  const chat = extractReviewPayload(
    'Here is the review.\n```json\n{"findings":[{"id":"f1","title":"Unguarded value","body":"value is used without a bound.","severity":"high","path":"src/a.ts","side":"head","startLine":1,"endLine":1,"evidence":[{"contextItemId":"allowed","quote":"value = 1"}],"disposition":"pending"}]}\n```',
  );
  assert.equal(parseReviewResult(chat).findings[0].id, 'f1');
});

test('bad citations become rejected findings and do not fail the payload', () => {
  const mixed = acceptFindings(
    [
      grounded,
      {
        ...grounded,
        id: 'f2',
        evidence: [{ contextItemId: 'allowed', quote: 'invented-quote' }],
      },
      {
        ...grounded,
        id: 'f3',
        path: 'src/missing.ts',
      },
    ],
    packet,
  );
  assert.equal(mixed.length, 3);
  assert.equal(mixed[0].disposition, 'pending');
  assert.equal(mixed[1].disposition, 'rejected');
  assert.match(mixed[1].verification ?? '', /exact substring/);
  assert.equal(mixed[2].disposition, 'rejected');
  assert.match(mixed[2].verification ?? '', /outside the compiled snapshot scope/);
});

test('verifier soft-fails invented or omitted findings without aborting the run', () => {
  const original = acceptFindings([grounded], packet);
  const verified = acceptFindings(
    [
      {
        ...original[0],
        title: 'mutated',
        disposition: 'supported',
        verification: 'Looks real.',
      },
      {
        ...grounded,
        id: 'invented',
        disposition: 'supported',
        verification: 'new',
      },
    ],
    packet,
    original,
  );
  assert.equal(verified.length, 1);
  assert.equal(verified[0].title, original[0].title);
  assert.equal(verified[0].disposition, 'rejected');
  const omitted = acceptFindings([], packet, original);
  assert.equal(omitted.length, 1);
  assert.equal(omitted[0].disposition, 'uncertain');
});
