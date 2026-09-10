import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  datasetSummary,
  freezeDataset,
  isNeutralSourceMessage,
  isConventionalFixMessage,
  isWeakDefectOracle,
  mineCleanCommit,
  mineFixCommit,
  selectCleanControls,
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

test('neutral source subjects are refactors, renames, and perf; docs and deps are not', () => {
  assert.equal(isNeutralSourceMessage('refactor: extract total helper'), true);
  assert.equal(isNeutralSourceMessage('perf(parser): cache tokens'), true);
  assert.equal(isNeutralSourceMessage('rename: total -> sum'), true);
  assert.equal(isNeutralSourceMessage('docs: explain the CLI'), false);
  assert.equal(isNeutralSourceMessage('chore(deps): bump zod to 4.1.12'), false);
  assert.equal(isNeutralSourceMessage('fix: actually a bug'), false);
});

test('weak defect oracles include typo, locale copy, type/noop, and export/types', () => {
  assert.equal(
    isWeakDefectOracle('fix: typo', [{ path: 'src/a.ts', quote: 'const name = 1;' }]),
    true,
  );
  assert.equal(
    isWeakDefectOracle('fix(locales): clarify Tajik discriminator value message', [
      { path: 'packages/zod/src/v4/locales/tg.ts', quote: 'return `bad`;' },
    ]),
    true,
  );
  assert.equal(
    isWeakDefectOracle('fix: #507 explained workaround better', [
      { path: 'src/types-external.ts', quote: 'export function noop() {}' },
    ]),
    true,
  );
  assert.equal(
    isWeakDefectOracle('fix: export', [{ path: 'src/index.js', quote: 'export default fetch;' }]),
    true,
  );
  assert.equal(
    isWeakDefectOracle('fix: release URL class argument', [
      { path: '@types/index.d.ts', quote: 'constructor(input: RequestInfo | URL);' },
    ]),
    true,
  );
  assert.equal(
    isWeakDefectOracle('fix: reject negative quantities', [
      { path: 'src/total.ts', quote: 'if (quantity === 0) throw new Error("bad");' },
    ]),
    false,
  );
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
    assert.equal(mined.filesChanged, 1);
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

test('mineCleanCommit accepts source refactors and rejects docs, formatting, and dependency bumps', async () => {
  const path = await repo();
  try {
    await write(
      path,
      'src/app.ts',
      'export const value = 1;\nexport function total(n: number) {\n  return n;\n}\n',
    );
    await write(path, 'README.md', '# App\n');
    await write(path, 'package.json', '{"dependencies":{"left-pad":"1.0.0"}}\n');
    await commit(path, 'feat: seed');

    await write(
      path,
      'src/app.ts',
      'export const value = 1;\nexport function sum(n: number) {\n  return n;\n}\n',
    );
    const refactor = await commit(path, 'refactor: rename total to sum', '2018-04-04T04:00:00Z');
    const refactorCase = await mineCleanCommit(path, refactor, { repository: 'example/app' });
    assert.ok(refactorCase);
    assert.equal(refactorCase.kind, 'clean');
    assert.equal(refactorCase.head, refactor);
    assert.equal(refactorCase.labels.length, 0);
    assert.equal(refactorCase.commitDate, '2018-04-04T04:00:00Z');
    assert.equal(refactorCase.filesChanged, 1);

    await write(path, 'README.md', '# App\n\nUsage notes.\n');
    const docs = await commit(path, 'docs: explain usage');
    assert.equal(await mineCleanCommit(path, docs, { repository: 'example/app' }), null);

    await write(
      path,
      'src/app.ts',
      'export const value = 1;\nexport function sum(n: number) {\n  return n;\n}  \n',
    );
    const style = await commit(path, 'style: trim trailing noise');
    assert.equal(await mineCleanCommit(path, style, { repository: 'example/app' }), null);

    await write(path, 'package.json', '{"dependencies":{"left-pad":"1.0.1"}}\n');
    const bump = await commit(path, 'chore(deps): bump left-pad');
    assert.equal(await mineCleanCommit(path, bump, { repository: 'example/app' }), null);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test('mineFixCommit drops typo-only fixes', async () => {
  const path = await repo();
  try {
    await write(path, 'src/a.ts', 'export const nmae = 1;\n');
    await commit(path, 'feat: add a');
    await write(path, 'src/a.ts', 'export const name = 1;\n');
    const fix = await commit(path, 'fix: typo');
    assert.equal(await mineFixCommit(path, fix, { repository: 'example/a' }), null);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test('selectCleanControls matches defect file-count and spreads dates', () => {
  const defects = [2, 7, 7, 8, 12].map((filesChanged, index) => ({
    id: `defect-${index}`,
    repoPath: 'repos/x',
    base: 'b',
    head: 'h',
    task: 't',
    labels: [{ id: 'l', description: 'd', path: 'src/a.ts', quote: 'x' }],
    packs: [] as [],
    kind: 'defect' as const,
    commitDate: [
      '2017-01-01T00:00:00Z',
      '2019-01-01T00:00:00Z',
      '2022-01-01T00:00:00Z',
      '2025-01-01T00:00:00Z',
      '2026-06-01T00:00:00Z',
    ][index],
    sourceRepository: 'example/x',
    cloneUrl: 'https://github.com/example/x.git',
    sourceCommit: `d${index}`,
    filesChanged,
  }));
  const pool = [
    { filesChanged: 1, commitDate: '2026-09-01T00:00:00Z', sourceCommit: 'tiny' },
    { filesChanged: 7, commitDate: '2017-06-01T00:00:00Z', sourceCommit: 'old' },
    { filesChanged: 8, commitDate: '2020-06-01T00:00:00Z', sourceCommit: 'mid' },
    { filesChanged: 7, commitDate: '2026-07-01T00:00:00Z', sourceCommit: 'new' },
    { filesChanged: 20, commitDate: '2018-01-01T00:00:00Z', sourceCommit: 'huge' },
  ].map((row, index) => ({
    id: `clean-${index}`,
    repoPath: 'repos/x',
    base: 'b',
    head: 'h',
    task: 't',
    labels: [],
    packs: [] as [],
    kind: 'clean' as const,
    commitDate: row.commitDate,
    sourceRepository: 'example/x',
    cloneUrl: 'https://github.com/example/x.git',
    sourceCommit: row.sourceCommit,
    filesChanged: row.filesChanged,
  }));
  const selected = selectCleanControls(pool, defects, 3);
  assert.equal(selected.length, 3);
  const files = selected.map((sample) => sample.filesChanged!).sort((a, b) => a - b);
  assert.deepEqual(files, [7, 7, 8]);
  const years = selected.map((sample) => sample.commitDate.slice(0, 4)).sort();
  assert.equal(years[0], '2017');
  assert.equal(years.at(-1), '2026');
  const summary = datasetSummary([...defects, ...selected]);
  assert.equal(summary.filesChanged.defect.median, 7);
  assert.equal(summary.filesChanged.clean.median, 7);
  assert.equal(summary.postCutoffDefects, 1);
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
