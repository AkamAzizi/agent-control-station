import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/context/index.js';
import { snapshot, validateRepository } from '../src/repository/index.js';
import { DEFAULT_POLICY, Snapshot } from '../src/types.js';

function repo(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'agent-station-context-'));
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Context Test']);
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
function commit(path: string, message: string): string {
  execFileSync('git', ['-C', path, 'add', '-A']);
  execFileSync('git', ['-C', path, 'commit', '-qm', message]);
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
function write(path: string, relative: string, value: string): void {
  const target = join(path, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, value);
}

test('snapshot pins immutable revisions and reports rename/deletion hunks', async () => {
  const r = repo();
  try {
    write(
      r.path,
      'src/old.ts',
      'export function oldName(): number {\n  const base = 1;\n  return base + 1;\n}\n\nexport const stable = true;\n',
    );
    const base = commit(r.path, 'base');
    execFileSync('git', ['-C', r.path, 'mv', 'src/old.ts', 'src/new.ts']);
    write(
      r.path,
      'src/new.ts',
      'export function newName(): number {\n  const base = 1;\n  return base + 1;\n}\n\nexport const stable = true;\n',
    );
    write(r.path, 'src/removed.ts', 'export const removed = true;\n');
    commit(r.path, 'rename and add');
    const head = execFileSync('git', ['-C', r.path, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', r.path, 'rm', 'src/removed.ts']);
    const deletedHead = commit(r.path, 'delete');
    const first = await snapshot(r.path, base, head);
    assert.equal(first.base, base);
    assert.equal(first.head, head);
    assert.equal(first.mergeBase, base);
    assert.ok(
      first.files.some(
        (file) =>
          file.status === 'renamed' && file.path === 'src/new.ts' && file.oldPath === 'src/old.ts',
      ),
    );
    assert.equal(first.sources.base['src/old.ts'].includes('oldName'), true);
    assert.equal(first.sources.head['src/new.ts'].includes('newName'), true);
    const second = await snapshot(r.path, head, deletedHead);
    assert.ok(
      second.files.some(
        (file) =>
          file.status === 'deleted' && file.path === 'src/removed.ts' && file.hunks.length > 0,
      ),
    );
    assert.equal(second.sources.base['src/removed.ts'].includes('removed'), true);
  } finally {
    r.cleanup();
  }
});

test('context selects changed definitions, imports, tests and relevant pack deterministically', async () => {
  const r = repo();
  try {
    write(
      r.path,
      'src/lib.ts',
      'export function helper(value: number): number { return value + 1; }\n',
    );
    write(
      r.path,
      'src/main.ts',
      'import { helper } from "./lib";\nexport function run(): number { return helper(1); }\n',
    );
    write(
      r.path,
      'src/main.test.ts',
      'import { run } from "./main";\nexport function testRun(): number { return run(); }\n',
    );
    const base = commit(r.path, 'base');
    write(
      r.path,
      'src/main.ts',
      'import { helper } from "./lib";\nexport function run(): number { return helper(2); }\n',
    );
    const head = commit(r.path, 'change');
    const snap = await snapshot(r.path, base, head);
    const packs = [
      {
        id: 'ts',
        version: 2,
        name: 'TypeScript',
        active: true,
        globs: ['src/**/*.ts'],
        roles: ['reviewer'] as ('reviewer' | 'verifier')[],
        rules: [{ id: 'r1', text: 'Check changed behavior.' }],
      },
    ];
    const packet = compile(snap, 'Review changed behavior', {}, packs);
    assert.equal(packet.status, 'ready');
    assert.ok(packet.manifest.items.some((item) => item.reason === 'mandatory review diff'));
    assert.ok(packet.manifest.items.some((item) => item.symbol === 'run'));
    assert.ok(packet.manifest.items.some((item) => item.reason === 'dependency of changed code'));
    assert.deepEqual(packet.manifest.packs, [{ id: 'ts', version: 2 }]);
    const again = compile(snap, 'Review changed behavior', {}, packs);
    assert.equal(packet.id, again.id);
    assert.equal(packet.prompt, again.prompt);
    const scoped = compile(snap, 'Review changed behavior', {}, packs, ['src/main.ts']);
    assert.ok(scoped.manifest.limitations.some((item) => item.startsWith('Partial scope:')));
    assert.equal(
      scoped.manifest.items.some((item) => item.path === 'src/lib.ts'),
      false,
    );
  } finally {
    r.cleanup();
  }
});

test('mandatory diff and definitions produce needs_input instead of silent truncation', async () => {
  const snapshotValue: Snapshot = {
    id: 'stable-snapshot',
    repoPath: '/different/on/every/machine',
    base: 'base',
    head: 'head',
    mergeBase: 'base',
    diff: '@@ -1 +1 @@\n-long\n+longer\n',
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        binary: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
      },
    ],
    sources: {
      base: { 'src/a.ts': 'export function a() { return 1; }\n' },
      head: { 'src/a.ts': 'export function a() { return 2; }\n' },
    },
    limitations: [],
  };
  const packet = compile(snapshotValue, 'x', { ...DEFAULT_POLICY, maxBytes: 32, maxPackBytes: 8 });
  assert.equal(packet.status, 'needs_input');
  assert.ok(packet.manifest.limitations.some((item) => item.includes('Mandatory')));
  const changed = compile(snapshotValue, 'x');
  assert.equal(changed.id, compile({ ...snapshotValue, repoPath: '/another/path' }, 'x').id);
});

test('validateRepository rejects non-repositories', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-station-not-git-'));
  try {
    await assert.rejects(() => validateRepository(directory), /Not a Git repository/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dependency context resolves the imported symbol, not same-named exports elsewhere', async () => {
  const r = repo();
  try {
    write(
      r.path,
      'src/a.ts',
      'export function helper(value: number): number { return value + 1; }\n',
    );
    write(
      r.path,
      'src/b.ts',
      'export function helper(value: number): number { return value - 1; }\n',
    );
    write(
      r.path,
      'src/main.ts',
      'import { helper } from "./a.js";\nexport function run(): number { return helper(1); }\n',
    );
    const base = commit(r.path, 'base');
    write(
      r.path,
      'src/main.ts',
      'import { helper } from "./a.js";\nexport function run(): number { return helper(2); }\n',
    );
    const head = commit(r.path, 'change');
    const packet = compile(await snapshot(r.path, base, head), 'trace call', {
      dependencyDepth: 1,
    });
    const dependencies = packet.manifest.items.filter(
      (item) => item.reason === 'dependency of changed code',
    );
    assert.ok(dependencies.some((item) => item.path === 'src/a.ts' && item.symbol === 'helper'));
    assert.equal(
      dependencies.some((item) => item.path === 'src/b.ts'),
      false,
    );
  } finally {
    r.cleanup();
  }
});

test('snapshot excludes secret/vendor/symlink diff content but keeps changed text fallback', async () => {
  const r = repo();
  try {
    write(r.path, 'README.md', 'before\n');
    write(r.path, 'src/main.ts', 'export const main = 1;\n');
    write(r.path, 'nested/vendor/old.ts', 'export const vendor = 1;\n');
    write(r.path, '.env', 'TOKEN=before\n');
    const base = commit(r.path, 'base');
    write(r.path, 'README.md', 'after metadata\n');
    write(r.path, 'src/main.ts', 'export const main = 2;\n');
    write(r.path, 'nested/vendor/old.ts', 'export const vendor = 2;\n');
    write(r.path, '.env', 'TOKEN=secret\n');
    symlinkSync('src/main.ts', join(r.path, 'src/link.ts'));
    const head = commit(r.path, 'changed excluded files');
    const snap = await snapshot(r.path, base, head);
    assert.equal(snap.diff.includes('TOKEN=secret'), false);
    assert.equal(snap.diff.includes('vendor = 2'), false);
    assert.equal(snap.diff.includes('src/link.ts'), false);
    assert.equal(snap.sources.head['README.md'], 'after metadata\n');
    assert.equal(snap.sources.head['.env'], undefined);
    const packet = compile(snap, 'review metadata');
    assert.ok(
      packet.manifest.items.some(
        (item) => item.reason === 'changed text fallback' && item.path === 'README.md',
      ),
    );
    assert.ok(packet.manifest.limitations.some((item) => item.includes('Skipped changed path')));
  } finally {
    r.cleanup();
  }
});

test('dependency depth follows initializer callees and includes untouched helpers in changed files', async () => {
  const r = repo();
  try {
    write(r.path, 'src/leaf.ts', 'export function leaf(): number { return 1; }\n');
    write(
      r.path,
      'src/mid.ts',
      'import { leaf } from "./leaf.js";\nexport function mid(): number { return leaf(); }\n',
    );
    write(
      r.path,
      'src/main.ts',
      'import { mid } from "./mid.js";\nfunction localHelper(value: number): number { return value + 1; }\nexport function run(): number {\n  const value = mid();\n  return localHelper(value);\n}\n',
    );
    const base = commit(r.path, 'base');
    write(
      r.path,
      'src/main.ts',
      'import { mid } from "./mid.js";\nfunction localHelper(value: number): number { return value + 1; }\nexport function run(): number {\n  const value = mid() + 1;\n  return localHelper(value);\n}\n',
    );
    const head = commit(r.path, 'change');
    const snap = await snapshot(r.path, base, head);
    const depthOne = compile(snap, 'trace', { dependencyDepth: 1 });
    const depthOneDeps = depthOne.manifest.items.filter(
      (item) => item.reason === 'dependency of changed code',
    );
    assert.ok(depthOneDeps.some((item) => item.path === 'src/mid.ts' && item.symbol === 'mid'));
    assert.ok(
      depthOneDeps.some((item) => item.path === 'src/main.ts' && item.symbol === 'localHelper'),
    );
    assert.equal(
      depthOneDeps.some((item) => item.path === 'src/leaf.ts'),
      false,
    );
    const depthTwo = compile(snap, 'trace', { dependencyDepth: 2 });
    assert.ok(
      depthTwo.manifest.items.some((item) => item.path === 'src/leaf.ts' && item.symbol === 'leaf'),
    );
    const depthZero = compile(snap, 'trace', { dependencyDepth: 0 });
    assert.equal(
      depthZero.manifest.items.some((item) => item.reason === 'dependency of changed code'),
      false,
    );
  } finally {
    r.cleanup();
  }
});

test('snapshot excludes nested secrets and deleted symlinks without treating pathspec syntax specially', async () => {
  const r = repo();
  try {
    write(r.path, 'src/main.ts', 'export const main = 1;\n');
    write(r.path, 'src/.env', 'TOKEN=before\n');
    write(r.path, ':(exclude)src/main.ts', 'export const literal = 1;\n');
    symlinkSync('main.ts', join(r.path, 'src/deleted-link.ts'));
    const base = commit(r.path, 'base');
    write(r.path, 'src/main.ts', 'export const main = 2;\n');
    write(r.path, 'src/.env', 'TOKEN=must-not-leak\n');
    write(r.path, ':(exclude)src/main.ts', 'export const literal = 2;\n');
    rmSync(join(r.path, 'src/deleted-link.ts'));
    const head = commit(r.path, 'head');
    const snap = await snapshot(r.path, base, head);
    assert.equal(snap.diff.includes('must-not-leak'), false);
    assert.equal(snap.sources.base['src/.env'], undefined);
    assert.equal(snap.sources.head['src/.env'], undefined);
    assert.ok(snap.diff.includes('literal = 2'));
    assert.equal(snap.diff.includes('deleted-link.ts'), false);
    assert.ok(
      snap.files.some(
        (file) => file.path === 'src/deleted-link.ts' && file.status === 'deleted' && file.binary,
      ),
    );
  } finally {
    r.cleanup();
  }
});

test('snapshot handles renamed paths with spaces and Unicode and ignores user diff configuration', async () => {
  const r = repo();
  try {
    write(
      r.path,
      'src/old name\tü.ts',
      'export function value(): number {\n  const stableA = 1;\n  const stableB = 2;\n  const stableC = 3;\n  return stableA + stableB + stableC + 1;\n}\n',
    );
    const base = commit(r.path, 'base');
    execFileSync('git', ['-C', r.path, 'mv', 'src/old name\tü.ts', 'src/new name\t漢.ts']);
    write(
      r.path,
      'src/new name\t漢.ts',
      'export function value(): number {\n  const stableA = 1;\n  const stableB = 2;\n  const stableC = 3;\n  return stableA + stableB + stableC + 2;\n}\n',
    );
    const head = commit(r.path, 'head');
    const first = await snapshot(r.path, base, head);
    execFileSync('git', ['-C', r.path, 'config', 'diff.algorithm', 'patience']);
    execFileSync('git', ['-C', r.path, 'config', 'diff.indentHeuristic', 'true']);
    execFileSync('git', ['-C', r.path, 'config', 'diff.noprefix', 'true']);
    execFileSync('git', ['-C', r.path, 'config', 'core.quotePath', 'true']);
    const second = await snapshot(r.path, base, head);
    assert.equal(second.diff, first.diff);
    assert.equal(second.id, first.id);
    assert.ok(
      first.files.some(
        (file) =>
          file.status === 'renamed' &&
          file.oldPath === 'src/old name\tü.ts' &&
          file.path === 'src/new name\t漢.ts' &&
          file.hunks.length,
      ),
    );
  } finally {
    r.cleanup();
  }
});

test('virtual TypeScript resolution follows root aliases, nested JSONC extends, JS re-exports, and exact symbols', async () => {
  const r = repo();
  try {
    write(
      r.path,
      'tsconfig.base.json',
      '{\n  // inherited aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@*": ["src/*"] } }\n}\n',
    );
    write(r.path, 'tsconfig.json', '{ "extends": "./tsconfig.base.json" }\n');
    write(
      r.path,
      'packages/app/tsconfig.json',
      '{\n  // nested config\n  "extends": "../../tsconfig.base.json"\n}\n',
    );
    write(r.path, 'src/leaf.ts', 'export const leaf = (): number => 7;\n');
    write(
      r.path,
      'src/impl.ts',
      'import { leaf } from "./leaf.js";\nexport const helper = (): number => leaf();\n',
    );
    write(r.path, 'src/barrel.ts', 'export { helper } from "./impl.js";\n');
    write(r.path, 'src/collision.ts', 'export const helper = (): number => -1;\n');
    write(
      r.path,
      'packages/app/main.ts',
      'import { helper } from "@barrel.js";\nexport const run = (): number => helper();\n',
    );
    write(
      r.path,
      'packages/app/main.test.ts',
      'import { run } from "./main.js";\nexport const related = (): number => run();\n',
    );
    write(
      r.path,
      'packages/app/unrelated.test.ts',
      'import { helper } from "../../src/collision.js";\nexport const unrelated = (): number => helper();\n',
    );
    const base = commit(r.path, 'base');
    write(
      r.path,
      'packages/app/main.ts',
      'import { helper } from "@barrel.js";\nexport const run = (): number => helper() + 1;\n',
    );
    const head = commit(r.path, 'head');
    const snap = await snapshot(r.path, base, head);
    const depthZero = compile(snap, 'review', { dependencyDepth: 0 });
    assert.equal(
      depthZero.manifest.items.some((item) => item.reason === 'dependency of changed code'),
      false,
    );
    const depthTwo = compile(snap, 'review', { dependencyDepth: 2 });
    const dependencies = depthTwo.manifest.items.filter(
      (item) => item.reason === 'dependency of changed code',
    );
    assert.ok(dependencies.some((item) => item.path === 'src/impl.ts' && item.symbol === 'helper'));
    assert.ok(dependencies.some((item) => item.path === 'src/leaf.ts' && item.symbol === 'leaf'));
    assert.equal(
      dependencies.some((item) => item.path === 'src/collision.ts'),
      false,
    );
    assert.ok(
      depthTwo.symbols.some(
        (symbol) => symbol.path === 'src/impl.ts' && symbol.name === 'helper' && symbol.exported,
      ),
    );
    assert.ok(
      depthTwo.manifest.items.some(
        (item) => item.reason === 'test selection' && item.path === 'packages/app/main.test.ts',
      ),
    );
    assert.equal(
      depthTwo.manifest.items.some(
        (item) =>
          item.reason === 'test selection' && item.path === 'packages/app/unrelated.test.ts',
      ),
      false,
    );
    assert.equal(
      depthTwo.manifest.limitations.some((item) => item.startsWith('Unresolved imports:')),
      false,
    );
  } finally {
    r.cleanup();
  }
});

test('package entrypoint metadata uses immutable source bytes and packs are whole, budgeted, and scope-bound', async () => {
  const r = repo();
  try {
    const packageJson =
      '{\n  "name": "fixture",\n  "exports": { ".": "./src/main.ts" },\n  "private": true\n}\n';
    write(r.path, 'package.json', packageJson);
    write(r.path, 'src/main.ts', 'export const main = 1;\n');
    write(r.path, 'ui/view.ts', 'export const view = 1;\n');
    const base = commit(r.path, 'base');
    write(r.path, 'src/main.ts', 'export const main = 2;\n');
    write(r.path, 'ui/view.ts', 'export const view = 2;\n');
    const head = commit(r.path, 'head');
    const snap = await snapshot(r.path, base, head);
    const packs = [
      {
        id: 'a-backend',
        version: 1,
        name: 'Backend',
        active: true,
        globs: ['src/**/*.ts'],
        roles: ['reviewer'] as const,
        rules: [{ id: 'complete', text: 'This complete rule must be present.' }],
      },
      {
        id: 'b-extra',
        version: 1,
        name: 'Extra',
        active: true,
        globs: ['src/**/*.ts'],
        roles: ['reviewer'] as const,
        rules: [{ id: 'never-partial', text: 'This entire second pack must be absent.' }],
      },
      {
        id: 'ui',
        version: 1,
        name: 'UI',
        active: true,
        globs: ['ui/**/*.ts'],
        roles: ['reviewer'] as const,
        rules: [{ id: 'ui-only', text: 'Do not leak into backend scope.' }],
      },
    ];
    const firstBlock =
      'Pack a-backend v1 (Backend)\n- complete: This complete rule must be present.';
    const packet = compile(
      snap,
      'review',
      { maxPackBytes: Buffer.byteLength(firstBlock) },
      packs.map((pack) => ({ ...pack, roles: [...pack.roles] })),
      ['src'],
    );
    assert.deepEqual(packet.manifest.packs, [{ id: 'a-backend', version: 1 }]);
    assert.ok(packet.prompt.includes(firstBlock));
    assert.equal(packet.prompt.includes('never-partial'), false);
    assert.equal(packet.prompt.includes('ui-only'), false);
    assert.ok(packet.manifest.omitted.some((item) => item.path === '__pack__/b-extra@1'));
    const unscoped = compile(snap, 'review');
    const metadata = unscoped.manifest.items.find(
      (item) => item.reason === 'package entrypoint metadata',
    );
    assert.equal(metadata?.path, 'package.json');
    assert.equal(metadata?.startLine, 1);
    assert.equal(metadata?.endLine, packageJson.split('\n').length);
    assert.equal(metadata?.content, packageJson);
  } finally {
    r.cleanup();
  }
});
