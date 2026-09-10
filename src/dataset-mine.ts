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
  'expressjs/express',
  'axios/axios',
  'reduxjs/redux',
  'preactjs/preact',
  'colinhacks/zod',
  'uuidjs/uuid',
  'tj/commander.js',
  'markedjs/marked',
  'immerjs/immer',
  'pmndrs/zustand',
  'jshttp/cookie',
  'pillarjs/path-to-regexp',
  'debug-js/debug',
  'expressjs/multer',
  'jaredpalmer/formik',
  'date-fns/date-fns',
  'yargs/yargs',
  'node-fetch/node-fetch',
  'caolan/async',
  'handlebars-lang/handlebars.js',
  'typicode/json-server',
  'react-hook-form/react-hook-form',
  'hapijs/joi',
  'sindresorhus/got',
];

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

export function isCleanCommitMessage(subject: string): boolean {
  return /^(docs|style|chore\((?:deps|dependencies|dep)\))(!)?:\s+\S/i.test(subject.trim());
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

function isFormattingMessage(subject: string): boolean {
  return (
    /^style(\([^)]+\))?(!)?:\s+\S/i.test(subject.trim()) ||
    /\b(prettier|whitespace|formatting)\b/i.test(subject)
  );
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
    const parents = await parentsOf(repoPath, commit);
    const base = parents[0];
    if (!base) return null;
    const files = await changedPaths(repoPath, base, commit);
    if (!files.length || files.length > 20) return null;
    const docsOnly = files.every(isDocPath);
    const depsOnly = files.every(isDepPath);
    const subject = await commitSubject(repoPath, commit);
    if (!docsOnly && !depsOnly) {
      if (!isFormattingMessage(subject) && !isCleanCommitMessage(subject)) return null;
      if (!(await diffIsWhitespaceOnly(repoPath, base, commit))) return null;
    }
    if (depsOnly) {
      const diff = await git(repoPath, ['diff', base, commit]);
      if (!/"((dev|peer|optional)?[Dd]ependencies)"/.test(diff) && !isCleanCommitMessage(subject))
        return null;
    }
    return buildCase(
      repoPath,
      options,
      'clean',
      commit,
      base,
      commit,
      await commitDate(repoPath, commit),
      [],
    );
  } catch {
    return null;
  }
}

export async function listRecentCommits(
  repoPath: string,
  max = 800,
): Promise<{ sha: string; subject: string }[]> {
  const raw = await git(repoPath, [
    'log',
    '--first-parent',
    `--max-count=${max}`,
    '--format=%H%x1f%s',
  ]);
  return raw
    .split('\n')
    .map((line) => {
      const [sha, subject] = line.split('\x1f');
      return sha && subject ? { sha, subject } : null;
    })
    .filter((row): row is { sha: string; subject: string } => Boolean(row));
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
  const defectLimit = options.maxDefects ?? 4;
  const cleanLimit = options.maxClean ?? 2;
  const extra = options.extraFixCommits ?? [];
  let defectAttempts = 0;
  let cleanAttempts = 0;
  const maxDefectAttempts = defectLimit * 25;
  const maxCleanAttempts = 800;
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
    if (cleans < cleanLimit && cleanAttempts < maxCleanAttempts) {
      cleanAttempts++;
      const mined = await mineCleanCommit(options.repoPath, commit.sha, mineOptions);
      if (mined && !cases.some((sample) => sample.sourceCommit === mined.sourceCommit))
        cases.push(mined);
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
  const cases: MinedCase[] = [];
  for (const repository of sources) {
    if (
      cases.filter((sample) => sample.kind === 'defect').length >= options.defectTarget &&
      cases.filter((sample) => sample.kind === 'clean').length >= options.cleanTarget
    )
      break;
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
      maxDefects: options.maxDefectsPerRepo ?? 4,
      maxClean: options.maxCleanPerRepo ?? 2,
    });
    console.error(
      `  ${repository}: ${mined.filter((sample) => sample.kind === 'defect').length} defect, ${mined.filter((sample) => sample.kind === 'clean').length} clean`,
    );
    for (const sample of mined) {
      const defects = cases.filter((row) => row.kind === 'defect').length;
      const cleans = cases.filter((row) => row.kind === 'clean').length;
      if (sample.kind === 'defect' && defects >= options.defectTarget) continue;
      if (sample.kind === 'clean' && cleans >= options.cleanTarget) continue;
      if (!cases.some((row) => row.id === sample.id)) cases.push(sample);
    }
  }
  return { cases };
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
  };
}

export async function writeFrozenDataset(cases: MinedCase[], directory: string) {
  await mkdir(directory, { recursive: true });
  const datasetPath = join(directory, 'benchmark.dataset.json');
  const frozen = {
    cases: cases.map(frozenCase).sort((left, right) => (left.id < right.id ? -1 : 1)),
  };
  await writeFile(datasetPath, `${JSON.stringify(frozen, null, 2)}\n`);
  return freezeDataset(datasetPath);
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
