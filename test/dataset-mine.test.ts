import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freezeDataset,
  isCleanCommitMessage,
  isConventionalFixMessage,
  mineCleanCommit,
  mineFixCommit,
} from '../src/dataset-mine.js';

function git(path: string, args: string[]) {
  return execFileSync('git', ['-C', path, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

async function repo() {
  const path = await mkdtemp(join(tmpdir(), 'station-mine-'));
  git(path, ['init', '-b', 'main']);
  git(path, ['config', 'user.email', 'mine@example.invalid']);
  git(path, ['config', 'user.name', 'Dataset Miner']);
  return path;
}

async function write(path: string, relative: string, value: string) {
  const target = join(path, relative);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, value);
}

async function commit(path: string, message: string, date = '2021-06-15T12:00:00Z') {
  git(path, ['add', '-A']);
  execFileSync('git', ['-C', path, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  return git(path, ['rev-parse', 'HEAD']);
}

test('conventional fix subjects match fix: and scoped fix()', () => {
  assert.equal(isConventionalFixMessage('fix: reject negative totals'), true);
  assert.equal(isConventionalFixMessage('fix(parser): handle empty input'), true);
  assert.equal(isConventionalFixMessage('fix!: breaking guard'), true);
  assert.equal(isConventionalFixMessage('feat: add totals'), false);
  assert.equal(isConventionalFixMessage('docs: mention the bug'), false);
});

test('clean commit subjects match docs, style, and dependency chores', () => {
  assert.equal(isCleanCommitMessage('docs: explain the CLI'), true);
  assert.equal(isCleanCommitMessage('style: prettier src'), true);
  assert.equal(isCleanCommitMessage('chore(deps): bump zod to 4.1.12'), true);
  assert.equal(isCleanCommitMessage('fix: actually a bug'), false);
});

test('mineFixCommit reviews the parent tree and labels the lines the fix touched', async () => {
  const path = await repo();
  try {
    await write(
      path,
      'src/total.ts',
      'export function total(quantity: number, price: number) {\n  if (quantity <= 0) throw new Error("bad");\n  return quantity * price;\n}\n',
    );
    const base = await commit(path, 'feat: guard non-positive quantities', '2020-01-01T00:00:00Z');
    await write(
      path,
      'src/total.ts',
      'export function total(quantity: number, price: number) {\n  if (quantity === 0) throw new Error("bad");\n  return quantity * price;\n}\n',
    );
    const head = await commit(path, 'refactor: simplify quantity check', '2020-02-01T00:00:00Z');
    await write(
      path,
      'src/total.ts',
      'export function total(quantity: number, price: number) {\n  if (quantity <= 0) throw new Error("bad");\n  return quantity * price;\n}\n',
    );
    const fix = await commit(path, 'fix: reject negative quantities again', '2020-03-01T00:00:00Z');
    const mined = await mineFixCommit(path, fix, {
      repository: 'example/totals',
      cloneUrl: 'https://github.com/example/totals.git',
    });
    assert.ok(mined);
    assert.equal(mined.kind, 'defect');
    assert.equal(mined.head, head);
    assert.equal(mined.base, base);
    assert.equal(mined.sourceCommit, fix);
    assert.equal(mined.commitDate, '2020-03-01T00:00:00Z');
    assert.equal(mined.labels.length, 1);
    assert.equal(mined.labels[0].path, 'src/total.ts');
    assert.equal(mined.labels[0].quote, 'if (quantity === 0) throw new Error("bad");');
    assert.match(mined.id, /^example-totals-defect-[0-9a-f]{8}$/);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test('mineFixCommit ignores feat commits that are not bug fixes', async () => {
  const path = await repo();
  try {
    await write(path, 'src/a.ts', 'export const a = 1;\n');
    await commit(path, 'feat: add a');
    await write(path, 'src/a.ts', 'export const a = 2;\n');
    const feat = await commit(path, 'feat: change a');
    assert.equal(await mineFixCommit(path, feat, { repository: 'example/a' }), null);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test('mineCleanCommit accepts docs-only, formatting-only, and dependency-bump commits', async () => {
  const path = await repo();
  try {
    await write(path, 'src/app.ts', 'export const value = 1;\n');
    await write(path, 'README.md', '# App\n');
    await write(path, 'package.json', '{"dependencies":{"left-pad":"1.0.0"}}\n');
    await commit(path, 'feat: seed');

    await write(path, 'README.md', '# App\n\nUsage notes.\n');
    const docs = await commit(path, 'docs: explain usage', '2022-04-04T04:00:00Z');
    const docsCase = await mineCleanCommit(path, docs, { repository: 'example/app' });
    assert.ok(docsCase);
    assert.equal(docsCase.kind, 'clean');
    assert.equal(docsCase.head, docs);
    assert.equal(docsCase.labels.length, 0);
    assert.equal(docsCase.commitDate, '2022-04-04T04:00:00Z');

    await write(path, 'src/app.ts', 'export const value = 1;  \n');
    const style = await commit(path, 'style: trim trailing noise');
    const styleCase = await mineCleanCommit(path, style, { repository: 'example/app' });
    assert.ok(styleCase);
    assert.equal(styleCase.kind, 'clean');
    assert.equal(styleCase.labels.length, 0);

    await write(path, 'package.json', '{"dependencies":{"left-pad":"1.0.1"}}\n');
    const bump = await commit(path, 'chore(deps): bump left-pad');
    const bumpCase = await mineCleanCommit(path, bump, { repository: 'example/app' });
    assert.ok(bumpCase);
    assert.equal(bumpCase.kind, 'clean');
    assert.equal(bumpCase.head, bump);

    await write(path, 'README.md', '# App\n\nUsage notes.\n\nMore.\n');
    await write(path, 'src/app.ts', 'export const value = 2;\n');
    const mixed = await commit(path, 'docs: mention the rewrite');
    assert.equal(await mineCleanCommit(path, mixed, { repository: 'example/app' }), null);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test('freezeDataset hashes the dataset bytes before any evaluation run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'station-freeze-'));
  try {
    const datasetPath = join(dir, 'benchmark.dataset.json');
    const body = `${JSON.stringify({ cases: [{ id: 'frozen-case' }] }, null, 2)}\n`;
    await writeFile(datasetPath, body);
    const frozen = await freezeDataset(datasetPath);
    const expected = createHash('sha256').update(body).digest('hex');
    assert.equal(frozen.sha256, expected);
    assert.equal(await readFile(frozen.hashPath, 'utf8'), `${expected}  benchmark.dataset.json\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
