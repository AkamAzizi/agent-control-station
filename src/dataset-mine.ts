import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { basename, join } from 'node:path';

const exec = promisify(execFile);
const CODE_RE = /\.(?:[cm]?tsx?|jsx?)$/i;
const SKIP_PATH =
  /(?:^|\/)(?:node_modules|vendor|third_party|third-party|dist|build|coverage|out)(?:\/|$)/i;
const DOC_FILE =
  /(?:^|\/)(?:readme|changelog|changes|license|copying|authors|notice|contributing)(?:\.[^/]+)?$/i;
const DOC_EXT = /\.(?:md|mdx|txt|rst|adoc)$/i;
const DOC_DIR = /(?:^|\/)(?:docs|documentation|changelog)(?:\/|$)/i;
const LOCK_FILE =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|bun\.lockb?)$/;
const PACKAGE_JSON = /(?:^|\/)package\.json$/;

export const DEFAULT_REPOSITORIES = [
  'markedjs/marked',
  'colinhacks/zod',
  'axios/axios',
  'expressjs/multer',
  'honojs/hono',
  'fastify/fastify',
  'unjs/h3',
  'unjs/ofetch',
  'sindresorhus/ky',
  'sindresorhus/execa',
  'ajv-validator/ajv',
  'graphql/graphql-js',
  'cheeriojs/cheerio',
  'mswjs/msw',
  'pmndrs/jotai',
  'pmndrs/valtio',
  'preactjs/preact',
  'jshttp/cookie',
  'chalk/chalk',
  'uuidjs/uuid',
  'yargs/yargs',
  'node-fetch/node-fetch',
  'immerjs/immer',
  'typicode/json-server',
  'solidjs/solid',
  'trpc/trpc',
  'drizzle-team/drizzle-orm',
  'vitest-dev/vitest',
  'debug-js/debug',
  'date-fns/date-fns',
  'reduxjs/redux',
  'expressjs/express',
  'tj/commander.js',
  'pillarjs/path-to-regexp',
  'caolan/async',
  'handlebars-lang/handlebars.js',
  'jaredpalmer/formik',
  'react-hook-form/react-hook-form',
  'sindresorhus/got',
  'pmndrs/zustand',
];
export const POST_CUTOFF = '2026-05-01';

export interface MinedLabel {
  id: string;
  description: string;
  path: string;
  quote: string;
}

export interface MinedCase {
  id: string;
  repoPath: string;
  base: string;
  head: string;
  task: string;
  labels: MinedLabel[];
  packs: [];
  kind: 'defect' | 'clean';
  commitDate: string;
  sourceRepository: string;
  cloneUrl: string;
  sourceCommit: string;
  filesChanged?: number;
}

export interface MineCommitOptions {
  repository: string;
  cloneUrl?: string;
  requireConventionalMessage?: boolean;
}

const TASK = 'Review this change for actionable correctness defects.';

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await exec('git', ['-C', repoPath, '--literal-pathspecs', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout.trim();
}

export function slugRepository(repository: string): string {
  return repository
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isConventionalFixMessage(subject: string): boolean {
  return /^fix(es|ed)?(\([^)]+\))?(!)?:\s+\S/i.test(subject.trim());
}

export function isNeutralSourceMessage(subject: string): boolean {
  return /^(refactor|perf|rename)(\([^)]+\))?(!)?:\s+\S/i.test(subject.trim());
}

export function cloneUrlFor(repository: string, cloneUrl?: string): string {
  return cloneUrl ?? `https://github.com/${repository}.git`;
}

function caseId(repository: string, kind: 'defect' | 'clean', sha: string): string {
  return `${slugRepository(repository)}-${kind}-${sha.slice(0, 8)}`;
}

function isDocPath(path: string): boolean {
  return DOC_EXT.test(path) || DOC_FILE.test(path) || DOC_DIR.test(path);
}

function isDepPath(path: string): boolean {
  return LOCK_FILE.test(path) || PACKAGE_JSON.test(path);
}

function isCodePath(path: string): boolean {
  return CODE_RE.test(path) && !SKIP_PATH.test(path);
}

function isReviewableDefectPath(path: string): boolean {
  if (!isCodePath(path)) return false;
  if (/\.(?:test|spec)\./i.test(path)) return false;
  if (/(?:^|\/)(?:examples?|benchmarks?|__tests__|tests|test|spec)(?:\/|$)/i.test(path))
    return false;
  return true;
}

function isAssetPath(path: string): boolean {
  return (
    /\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|gif)$/i.test(path) || /sponsor/i.test(path)
  );
}

function isExcludedCleanPath(path: string): boolean {
  return isDocPath(path) || isDepPath(path) || isAssetPath(path);
}

export function isPostCutoff(iso: string): boolean {
  return iso.slice(0, 10) >= POST_CUTOFF;
}

export function yearBucket(iso: string): string {
  const year = Number(iso.slice(0, 4));
  if (year <= 2018) return '2016-2018';
  if (year <= 2021) return '2019-2021';
  if (year <= 2024) return '2022-2024';
  if (!isPostCutoff(iso)) return '2025-2026-04';
  return '2026-05+';
}

export function isWeakDefectOracle(
  subject: string,
  labels: { path: string; quote: string }[],
): boolean {
  const text = subject.trim();
  if (/^fix(es|ed)?(\([^)]+\))?(!)?:\s*(typo|typos|export)\b/i.test(text)) return true;
  if (/\b(workaround|build issue)\b/i.test(text)) return true;
  if (/^fix(\([^)]+\))?:\s*clarify\b/i.test(text) && /locale/i.test(text)) return true;
  if (!labels.length) return false;
  if (labels.every((label) => /(?:^|\/)locales?(?:\/|$)/i.test(label.path))) return true;
  if (labels.every((label) => /(?:^|\/)@types(?:\/|$)/.test(label.path))) return true;
  if (labels.every((label) => isTypeOrNoopQuote(label.quote))) return true;
  return false;
}

function isTypeOrNoopQuote(quote: string): boolean {
  const text = quote.trim();
  if (/^export function noop\b/.test(text)) return true;
  if (/^(export\s+)?(type|interface)\b/.test(text)) return true;
  if (/^import\s/.test(text)) return true;
  return false;
}

export function median(values: number[]): number | null {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function numericDistribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    median: median(sorted),
    values: sorted,
  };
}

export function datasetSummary(cases: MinedCase[]) {
  const defects = cases.filter((sample) => sample.kind === 'defect');
  const cleans = cases.filter((sample) => sample.kind === 'clean');
  const dateRange = (rows: MinedCase[]) => {
    const dates = rows.map((sample) => sample.commitDate).sort();
    const buckets: Record<string, number> = {};
    for (const sample of rows) {
      const bucket = yearBucket(sample.commitDate);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    return { min: dates[0] ?? null, max: dates.at(-1) ?? null, buckets };
  };
  return {
    defects: defects.length,
    clean: cleans.length,
    postCutoffDefects: defects.filter((sample) => isPostCutoff(sample.commitDate)).length,
    filesChanged: {
      defect: numericDistribution(defects.map((sample) => sample.filesChanged ?? 0)),
      clean: numericDistribution(cleans.map((sample) => sample.filesChanged ?? 0)),
    },
    commitDate: { defect: dateRange(defects), clean: dateRange(cleans) },
  };
}

export function selectDefectCases(
  pool: MinedCase[],
  target: number,
  _postCutoffTarget: number,
): MinedCase[] {
  const unique: MinedCase[] = [];
  const seen = new Set<string>();
  for (const sample of pool) {
    if (sample.kind !== 'defect' || seen.has(sample.id)) continue;
    seen.add(sample.id);
    unique.push(sample);
  }
  const post = unique
    .filter((sample) => isPostCutoff(sample.commitDate))
    .sort((left, right) => (left.commitDate < right.commitDate ? 1 : -1));
  const pre = unique.filter((sample) => !isPostCutoff(sample.commitDate));
  const chosen: MinedCase[] = [];
  for (const sample of post) {
    if (chosen.length >= target) break;
    chosen.push(sample);
  }
  const remaining = target - chosen.length;
  const preByBucket = new Map<string, MinedCase[]>();
  for (const sample of pre) {
    const bucket = yearBucket(sample.commitDate);
    const list = preByBucket.get(bucket) ?? [];
    list.push(sample);
    preByBucket.set(bucket, list);
  }
  const buckets = [...preByBucket.keys()].sort();
  let added = 0;
  while (added < remaining) {
    let progressed = false;
    for (const bucket of buckets) {
      const list = preByBucket.get(bucket);
      if (!list?.length) continue;
      chosen.push(list.shift()!);
      added++;
      progressed = true;
      if (added >= remaining) break;
    }
    if (!progressed) break;
  }
  return chosen.slice(0, target);
}

export function selectCleanControls(
  pool: MinedCase[],
  defects: MinedCase[],
  target: number,
): MinedCase[] {
  const defectFiles = defects
    .map((sample) => sample.filesChanged ?? 0)
    .filter((value) => value > 0);
  const med = median(defectFiles) ?? 7;
  const defectMin = Math.min(...defectFiles, med);
  const defectMax = Math.max(...defectFiles, med);
  const distance = (sample: MinedCase) => Math.abs((sample.filesChanged ?? 0) - med);
  const candidates = pool
    .filter((sample) => sample.kind === 'clean' && (sample.filesChanged ?? 0) > 0)
    .slice()
    .sort((left, right) => distance(left) - distance(right) || left.id.localeCompare(right.id));
  const inRange = (value: number, slack: number) =>
    value >= Math.max(defectMin, med - slack) && value <= Math.min(defectMax, med + slack);
  let slack = 3;
  let inBand = candidates.filter((sample) => inRange(sample.filesChanged ?? 0, slack));
  while (inBand.length < target && slack < 20) {
    slack += 1;
    inBand = candidates.filter((sample) => inRange(sample.filesChanged ?? 0, slack));
  }
  const defectBuckets = new Map<string, number>();
  for (const sample of defects) {
    const bucket = yearBucket(sample.commitDate);
    defectBuckets.set(bucket, (defectBuckets.get(bucket) ?? 0) + 1);
  }
  const quota = new Map<string, number>();
  let assigned = 0;
  const total = defects.length || 1;
  for (const [bucket, count] of defectBuckets) {
    const share = Math.max(1, Math.round((count / total) * target));
    quota.set(bucket, share);
    assigned += share;
  }
  while (assigned > target) {
    const key = [...quota.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
    if (!key || (quota.get(key) ?? 0) <= 0) break;
    quota.set(key, (quota.get(key) ?? 0) - 1);
    assigned--;
  }
  while (assigned < target && quota.size) {
    const key = [...quota.entries()].sort((left, right) => left[1] - right[1])[0]?.[0];
    if (!key) break;
    quota.set(key, (quota.get(key) ?? 0) + 1);
    assigned++;
  }
  const chosen: MinedCase[] = [];
  const used = new Set<string>();
  const byBucket = new Map<string, MinedCase[]>();
  for (const sample of inBand) {
    const bucket = yearBucket(sample.commitDate);
    const list = byBucket.get(bucket) ?? [];
    list.push(sample);
    byBucket.set(bucket, list);
  }
  for (const [bucket, share] of quota) {
    let filled = 0;
    for (const sample of byBucket.get(bucket) ?? []) {
      if (filled >= share || chosen.length >= target) break;
      if (used.has(sample.id)) continue;
      used.add(sample.id);
      chosen.push(sample);
      filled++;
    }
  }
  for (const sample of inBand) {
    if (chosen.length >= target) break;
    if (used.has(sample.id)) continue;
    used.add(sample.id);
    chosen.push(sample);
  }
  return chosen.slice(0, target);
}

function parseRemovedCodeLines(diff: string): { path: string; quote: string }[] {
  const found: { path: string; quote: string }[] = [];
  const seen = new Set<string>();
  let path = '';
  let oldPath = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = '';
      oldPath = '';
      continue;
    }
    if (line.startsWith('--- ')) {
      const raw = line.slice(4);
      oldPath = raw.startsWith('a/') ? raw.slice(2) : raw === '/dev/null' ? '' : raw;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4);
      const next = raw === '/dev/null' ? '' : raw.startsWith('b/') ? raw.slice(2) : raw;
      path = next && next === (oldPath || next) ? next : '';
      continue;
    }
    if (!path || !isReviewableDefectPath(path)) continue;
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    const quote = line.slice(1).trim();
    if (quote.length < 8 || quote.length > 200) continue;
    if (quote === '{' || quote === '}' || quote.startsWith('//') || quote.startsWith('*')) continue;
    const key = `${path}\0${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ path, quote });
    if (found.length >= 5) break;
  }
  return found;
}

async function commitSubject(repoPath: string, sha: string): Promise<string> {
  return git(repoPath, ['log', '-1', '--format=%s', sha]);
}

async function commitDate(repoPath: string, sha: string): Promise<string> {
  return git(repoPath, ['log', '-1', '--format=%aI', sha]);
}

async function parentsOf(repoPath: string, sha: string): Promise<string[]> {
  const raw = await git(repoPath, ['log', '-1', '--format=%P', sha]);
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

async function ensureCommit(repoPath: string, sha: string): Promise<boolean> {
  try {
    await git(repoPath, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    try {
      await git(repoPath, ['fetch', 'origin', sha]);
      await git(repoPath, ['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }
}

async function changedPaths(repoPath: string, base: string, head: string): Promise<string[]> {
  const raw = await git(repoPath, [
    'diff-tree',
    '-r',
    '-z',
    '--name-only',
    '--no-commit-id',
    base,
    head,
  ]);
  return raw.split('\0').filter(Boolean);
}

async function diffIsWhitespaceOnly(
  repoPath: string,
  base: string,
  head: string,
): Promise<boolean> {
  const full = await git(repoPath, ['diff', '--unified=0', base, head]);
  if (!full.trim()) return false;
  const ignored = await git(repoPath, [
    'diff',
    '-w',
    '--ignore-blank-lines',
    '--ignore-space-at-eol',
    base,
    head,
  ]);
  return !ignored.trim();
}

async function chooseBase(
  repoPath: string,
  head: string,
  labels: { path: string; quote: string }[],
): Promise<string | null> {
  const blamed = new Set<string>();
  for (const label of labels) {
    let content: string;
    try {
      content = await git(repoPath, ['show', `${head}:${label.path}`]);
    } catch {
      return null;
    }
    if (!content.includes(label.quote)) return null;
    const lines = content.split('\n');
    const index = lines.findIndex((line) => line.includes(label.quote));
    if (index < 0) return null;
    let blame: string;
    try {
      blame = await git(repoPath, [
        'blame',
        '-L',
        `${index + 1},${index + 1}`,
        '--porcelain',
        head,
        '--',
        label.path,
      ]);
    } catch {
      return null;
    }
    const sha = blame.split(/\s+/, 1)[0];
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    blamed.add(sha);
  }
  const dated = await Promise.all(
    [...blamed].map(async (sha) => ({
      sha,
      date: await git(repoPath, ['log', '-1', '--format=%aI', sha]),
    })),
  );
  dated.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const oldest = dated[0]?.sha;
  if (!oldest) return null;
  const parents = await parentsOf(repoPath, oldest);
  return parents[0] ?? null;
}

async function quoteIntroducedInDiff(
  repoPath: string,
  base: string,
  head: string,
  label: { path: string; quote: string },
): Promise<boolean> {
  const diff = await git(repoPath, ['diff', '--unified=0', base, head, '--', label.path]);
  return diff.split('\n').some((line) => line.startsWith('+') && line.includes(label.quote));
}

function buildCase(
  repoPath: string,
  options: MineCommitOptions,
  kind: 'defect' | 'clean',
  sourceCommit: string,
  base: string,
  head: string,
  date: string,
  labels: MinedLabel[],
  filesChanged: number,
): MinedCase {
  return {
    id: caseId(options.repository, kind, sourceCommit),
    repoPath,
    base,
    head,
    task: TASK,
    labels,
    packs: [],
    kind,
    commitDate: date,
    sourceRepository: options.repository,
    cloneUrl: cloneUrlFor(options.repository, options.cloneUrl),
    sourceCommit,
    filesChanged,
  };
}

export async function mineFixCommit(
  repoPath: string,
  commit: string,
  options: MineCommitOptions,
): Promise<MinedCase | null> {
  try {
    if (!(await ensureCommit(repoPath, commit))) return null;
    const subject = await commitSubject(repoPath, commit);
    if (options.requireConventionalMessage !== false && !isConventionalFixMessage(subject))
      return null;
    const parents = await parentsOf(repoPath, commit);
    const head = parents[0];
    if (!head) return null;
    if (!(await ensureCommit(repoPath, head))) return null;
    const fixFiles = await changedPaths(repoPath, `${commit}^1`, commit);
    const codeFiles = fixFiles.filter(isReviewableDefectPath);
    if (!codeFiles.length || fixFiles.length > 20) return null;
    const diff = await git(repoPath, [
      'diff',
      '--unified=0',
      '--no-renames',
      `${commit}^1`,
      commit,
      '--',
      ...codeFiles,
    ]);
    const removed = parseRemovedCodeLines(diff);
    if (!removed.length) return null;
    const base = await chooseBase(repoPath, head, removed);
    if (!base) return null;
    if (!(await ensureCommit(repoPath, base))) return null;
    const files = await changedPaths(repoPath, base, head);
    if (files.length === 0 || files.length > 20) return null;
    const labels: MinedLabel[] = [];
    for (const [index, line] of removed.entries()) {
      if (!files.includes(line.path)) continue;
      if (!(await quoteIntroducedInDiff(repoPath, base, head, line))) continue;
      labels.push({
        id: `${line.path
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/^-+|-+$/g, '')
          .toLowerCase()}-${index + 1}`,
        description: `A later bug-fix replaced this line in ${line.path}.`,
        path: line.path,
        quote: line.quote,
      });
    }
    if (!labels.length) return null;
    if (isWeakDefectOracle(subject, labels)) return null;
    const stat = await git(repoPath, ['diff', '--shortstat', base, head]);
    const changed =
      Number(/(\d+) insertions?/.exec(stat)?.[1] ?? 0) +
      Number(/(\d+) deletions?/.exec(stat)?.[1] ?? 0);
    if (changed > 800) return null;
    const behind = Number(await git(repoPath, ['rev-list', '--count', `${base}..${head}`]));
    if (behind > 40) return null;
    return buildCase(
      repoPath,
      options,
      'defect',
      commit,
      base,
      head,
      await commitDate(repoPath, commit),
      labels,
      files.length,
    );
  } catch {
    return null;
  }
}

export async function mineCleanCommit(
  repoPath: string,
  commit: string,
  options: MineCommitOptions,
): Promise<MinedCase | null> {
  try {
    if (!(await ensureCommit(repoPath, commit))) return null;
    const subject = await commitSubject(repoPath, commit);
    if (!isNeutralSourceMessage(subject)) return null;
    const parents = await parentsOf(repoPath, commit);
    const base = parents[0];
    if (!base) return null;
    const files = await changedPaths(repoPath, base, commit);
    if (!files.length || files.length > 20) return null;
    if (!files.every(isCodePath) || files.some(isExcludedCleanPath)) return null;
    if (await diffIsWhitespaceOnly(repoPath, base, commit)) return null;
    return buildCase(
      repoPath,
      options,
      'clean',
      commit,
      base,
      commit,
      await commitDate(repoPath, commit),
      [],
      files.length,
    );
  } catch {
    return null;
  }
}

export async function listRecentCommits(
  repoPath: string,
  max = 2000,
): Promise<{ sha: string; subject: string; date: string }[]> {
  const raw = await git(repoPath, [
    'log',
    '--first-parent',
    `--max-count=${max}`,
    '--format=%H%x1f%s%x1f%aI',
  ]);
  return raw
    .split('\n')
    .map((line) => {
      const [sha, subject, date] = line.split('\x1f');
      return sha && subject && date ? { sha, subject, date } : null;
    })
    .filter((row): row is { sha: string; subject: string; date: string } => Boolean(row));
}

export async function listMergedBugFixShas(repository: string): Promise<string[]> {
  try {
    const query = `repo:${repository} label:bug is:pr is:merged`;
    const search = JSON.parse(
      (
        await exec('gh', ['api', `search/issues?q=${encodeURIComponent(query)}&per_page=15`], {
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        })
      ).stdout,
    ) as { items?: { number: number }[] };
    const shas: string[] = [];
    for (const item of search.items ?? []) {
      const pull = JSON.parse(
        (
          await exec('gh', ['api', `repos/${repository}/pulls/${item.number}`], {
            encoding: 'utf8',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          })
        ).stdout,
      ) as { merge_commit_sha?: string | null };
      if (pull.merge_commit_sha) shas.push(pull.merge_commit_sha);
    }
    return shas;
  } catch {
    return [];
  }
}

export async function ensureClone(cloneUrl: string, directory: string): Promise<string> {
  await mkdir(join(directory, '..'), { recursive: true });
  try {
    await access(join(directory, '.git'));
    try {
      await git(directory, ['fetch', '--no-filter', 'origin']);
    } catch {
      await git(directory, ['fetch', 'origin']);
    }
  } catch {
    await exec('git', ['clone', '--single-branch', '--no-tags', cloneUrl, directory], {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }
  return directory;
}

export async function mineRepository(options: {
  repoPath: string;
  repository: string;
  cloneUrl?: string;
  extraFixCommits?: string[];
  maxDefects?: number;
  maxClean?: number;
}): Promise<MinedCase[]> {
  const mineOptions = { repository: options.repository, cloneUrl: options.cloneUrl };
  const commits = await listRecentCommits(options.repoPath);
  const cases: MinedCase[] = [];
  const defectLimit = options.maxDefects ?? 5;
  const cleanLimit = options.maxClean ?? 10;
  const extra = options.extraFixCommits ?? [];
  let defectAttempts = 0;
  const maxDefectAttempts = defectLimit * 30;
  const cleanByBucket = new Map<string, number>();
  for (const sha of extra) {
    if (cases.filter((sample) => sample.kind === 'defect').length >= defectLimit) break;
    const mined = await mineFixCommit(options.repoPath, sha, {
      ...mineOptions,
      requireConventionalMessage: false,
    });
    if (mined && !cases.some((sample) => sample.id === mined.id)) cases.push(mined);
  }
  for (const commit of commits) {
    const defects = cases.filter((sample) => sample.kind === 'defect').length;
    const cleans = cases.filter((sample) => sample.kind === 'clean').length;
    if (defects >= defectLimit && cleans >= cleanLimit) break;
    if (
      defects < defectLimit &&
      defectAttempts < maxDefectAttempts &&
      isConventionalFixMessage(commit.subject)
    ) {
      defectAttempts++;
      const mined = await mineFixCommit(options.repoPath, commit.sha, mineOptions);
      if (mined && !cases.some((sample) => sample.id === mined.id)) cases.push(mined);
    }
    if (cleans < cleanLimit && isNeutralSourceMessage(commit.subject)) {
      const bucket = yearBucket(commit.date);
      if ((cleanByBucket.get(bucket) ?? 0) >= 2) continue;
      const mined = await mineCleanCommit(options.repoPath, commit.sha, mineOptions);
      if (mined && !cases.some((sample) => sample.sourceCommit === mined.sourceCommit)) {
        cases.push(mined);
        cleanByBucket.set(bucket, (cleanByBucket.get(bucket) ?? 0) + 1);
      }
    }
  }
  return cases;
}

export async function mineHeldOutDataset(options: {
  sources?: string[];
  cacheDir: string;
  defectTarget: number;
  cleanTarget: number;
  maxDefectsPerRepo?: number;
  maxCleanPerRepo?: number;
  github?: boolean;
}): Promise<{ cases: MinedCase[] }> {
  const sources = options.sources ?? DEFAULT_REPOSITORIES;
  const pool: MinedCase[] = [];
  for (const repository of sources) {
    const repoPath = join(options.cacheDir, slugRepository(repository));
    console.error(`Mining ${repository}…`);
    try {
      await ensureClone(cloneUrlFor(repository), repoPath);
    } catch (error) {
      console.error(
        `Skipping ${repository}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const extraFixCommits = options.github ? await listMergedBugFixShas(repository) : [];
    const mined = await mineRepository({
      repoPath,
      repository,
      extraFixCommits,
      maxDefects: options.maxDefectsPerRepo ?? 5,
      maxClean: options.maxCleanPerRepo ?? 10,
    });
    console.error(
      `  ${repository}: ${mined.filter((sample) => sample.kind === 'defect').length} defect, ${mined.filter((sample) => sample.kind === 'clean').length} clean`,
    );
    pool.push(...mined);
  }
  const defects = selectDefectCases(
    pool.filter((sample) => sample.kind === 'defect'),
    options.defectTarget,
    Math.ceil(options.defectTarget * 0.4),
  );
  const cleans = selectCleanControls(
    pool.filter((sample) => sample.kind === 'clean'),
    defects,
    options.cleanTarget,
  );
  return { cases: [...defects, ...cleans] };
}

export async function freezeDataset(datasetPath: string) {
  const body = await readFile(datasetPath);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const hashPath = datasetPath.endsWith('.json')
    ? `${datasetPath.slice(0, -'.json'.length)}.sha256`
    : `${datasetPath}.sha256`;
  await writeFile(hashPath, `${sha256}  ${basename(datasetPath)}\n`);
  return { sha256, hashPath, datasetPath };
}

export function frozenCase(sample: MinedCase): MinedCase {
  return {
    id: sample.id,
    repoPath: `repos/${slugRepository(sample.sourceRepository)}`,
    base: sample.base,
    head: sample.head,
    task: sample.task,
    labels: sample.labels,
    packs: [],
    kind: sample.kind,
    commitDate: sample.commitDate,
    sourceRepository: sample.sourceRepository,
    cloneUrl: sample.cloneUrl,
    sourceCommit: sample.sourceCommit,
    filesChanged: sample.filesChanged,
  };
}

export async function writeFrozenDataset(cases: MinedCase[], directory: string) {
  await mkdir(directory, { recursive: true });
  const datasetPath = join(directory, 'benchmark.dataset.json');
  const frozen = {
    summary: datasetSummary(cases),
    cases: cases.map(frozenCase).sort((left, right) => (left.id < right.id ? -1 : 1)),
  };
  await writeFile(datasetPath, `${JSON.stringify(frozen, null, 2)}\n`);
  return { ...(await freezeDataset(datasetPath)), summary: frozen.summary };
}

export async function fetchDatasetRepos(datasetPath: string, cacheDir: string) {
  const dataset = JSON.parse(await readFile(datasetPath, 'utf8')) as { cases: MinedCase[] };
  const seen = new Set<string>();
  for (const sample of dataset.cases) {
    const key = sample.sourceRepository;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const dest = join(cacheDir, slugRepository(key));
    console.error(`Fetching ${key}…`);
    await ensureClone(sample.cloneUrl || cloneUrlFor(key), dest);
  }
}
