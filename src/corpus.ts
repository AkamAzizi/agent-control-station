import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { JudgmentPack } from './types.js';

const exec = promisify(execFile);

export interface CorpusLabel {
  id: string;
  description: string;
  path: string;
  quote: string;
}

export interface CorpusCase {
  id: string;
  task: string;
  labels: CorpusLabel[];
  packs: JudgmentPack[];
  inspiredBy: { title: string; url: string }[];
  write: (path: string) => Promise<{ base: string; head: string }>;
}

async function gitRepo(path: string) {
  await mkdir(join(path, 'src'), { recursive: true });
  const git = (args: string[]) =>
    exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Station Corpus',
        '-c',
        'user.email=corpus@localhost',
        ...args,
      ],
      {
        cwd: path,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      },
    );
  await git(['init', '-b', 'main']);
  return {
    git,
    async commit(message: string) {
      await git(['add', '.']);
      await git(['commit', '-m', message]);
      return (await git(['rev-parse', 'HEAD'])).stdout.trim();
    },
  };
}

async function writeSource(root: string, relative: string, contents: string) {
  await mkdir(join(root, relative, '..'), { recursive: true });
  await writeFile(join(root, relative), contents);
}

export const CORPUS_CASES: CorpusCase[] = [
  {
    id: 'bounds-check',
    task: 'Review this change for actionable correctness defects in quantity validation.',
    labels: [
      {
        id: 'negative-quantity',
        description:
          'Negative quantities pass the new equality check and produce a negative total.',
        path: 'src/order.ts',
        quote: 'quantity === 0',
      },
    ],
    packs: [],
    inspiredBy: [
      {
        title: 'Incomplete numeric bounds (equality instead of relational check)',
        url: 'https://cwe.mitre.org/data/definitions/839.html',
      },
    ],
    write: async (path) => {
      const repo = await gitRepo(path);
      const order = (condition: string, marker = '') =>
        `export function createOrder(quantity: number, unitPrice: number) {\n  if (${condition}) throw new Error('Quantity must be positive');${marker}\n  return { quantity, total: quantity * unitPrice };\n}\n`;
      await writeSource(path, 'src/order.ts', order('quantity <= 0'));
      const base = await repo.commit('Reject non-positive quantities');
      await writeSource(
        path,
        'src/order.ts',
        order('quantity === 0', ' // STATION-DEFECT:negative-quantity'),
      );
      const head = await repo.commit('Simplify quantity validation');
      return { base, head };
    },
  },
  {
    id: 'assignment-guard',
    task: 'Review this authorization change for correctness defects.',
    labels: [
      {
        id: 'assignment-in-guard',
        description:
          'The condition assigns role to admin instead of comparing, so every caller is treated as admin.',
        path: 'src/auth.ts',
        quote: "role = 'admin'",
      },
    ],
    packs: [],
    inspiredBy: [
      {
        title: 'Assignment in a conditional (ESLint no-cond-assign)',
        url: 'https://eslint.org/docs/latest/rules/no-cond-assign',
      },
    ],
    write: async (path) => {
      const repo = await gitRepo(path);
      await writeSource(
        path,
        'src/auth.ts',
        `export function canModerate(role: string): boolean {\n  if (role === 'admin') return true;\n  return false;\n}\n`,
      );
      const base = await repo.commit('Compare the caller role');
      await writeSource(
        path,
        'src/auth.ts',
        `export function canModerate(role: string): boolean {\n  if ((role = 'admin')) return true; // STATION-DEFECT:assignment-in-guard\n  return false;\n}\n`,
      );
      const head = await repo.commit('Allow admin moderation');
      return { base, head };
    },
  },
  {
    id: 'dropped-await',
    task: 'Review this cache lookup change for correctness defects.',
    labels: [
      {
        id: 'missing-await',
        description:
          'loadUser is async but the new fallback does not await it, so callers receive a Promise.',
        path: 'src/users.ts',
        quote: 'cache.get(id) ?? loadUser(id)',
      },
    ],
    packs: [
      {
        id: 'await-async',
        version: 1,
        name: 'Await async results',
        active: true,
        globs: ['src/**/*.ts'],
        roles: ['reviewer', 'verifier'],
        rules: [
          {
            id: 'await-promises',
            text: 'If a helper is async, callers must await it before using the value as data.',
          },
        ],
      },
    ],
    inspiredBy: [
      {
        title: 'Unhandled promise / missing await (CWE-758 class of control-flow mistakes)',
        url: 'https://cwe.mitre.org/data/definitions/758.html',
      },
    ],
    write: async (path) => {
      const repo = await gitRepo(path);
      await writeSource(
        path,
        'src/users.ts',
        `const cache = new Map<string, { id: string }>();\nexport async function loadUser(id: string) {\n  return { id };\n}\nexport async function getUser(id: string) {\n  const cached = cache.get(id);\n  if (cached) return cached;\n  const user = await loadUser(id);\n  cache.set(id, user);\n  return user;\n}\n`,
      );
      const base = await repo.commit('Await user loads before caching');
      await writeSource(
        path,
        'src/users.ts',
        `const cache = new Map<string, { id: string }>();\nexport async function loadUser(id: string) {\n  return { id };\n}\nexport async function getUser(id: string) {\n  return cache.get(id) ?? loadUser(id); // STATION-DEFECT:missing-await\n}\n`,
      );
      const head = await repo.commit('Return cached users immediately');
      return { base, head };
    },
  },
];

export async function materializeCorpus(directory: string) {
  const cases = [];
  for (const sample of CORPUS_CASES) {
    const repoPath = join(directory, 'repos', sample.id);
    const refs = await sample.write(repoPath);
    cases.push({
      id: sample.id,
      repoPath,
      base: refs.base,
      head: refs.head,
      task: sample.task,
      labels: sample.labels,
      packs: sample.packs,
      inspiredBy: sample.inspiredBy,
    });
  }
  const dataset = { cases: cases.map(({ inspiredBy: _inspired, ...rest }) => rest) };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'dataset.json'), `${JSON.stringify(dataset, null, 2)}\n`);
  await writeFile(
    join(directory, 'sources.json'),
    `${JSON.stringify(
      cases.map((sample) => ({
        id: sample.id,
        inspiredBy: sample.inspiredBy,
        labels: sample.labels,
      })),
      null,
      2,
    )}\n`,
  );
  return { directory, dataset };
}
