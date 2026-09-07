import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, resolve } from 'node:path';
import { ChangedFile, DiffHunk, Snapshot } from '../types.js';

const execFileAsync = promisify(execFile);
const CODE_RE = /\.(?:[cm]?tsx?|jsx?)$/i;
const CONFIG_RE = /(?:^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i;
const SECRET_RE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|crt|cer))$/i;
const VENDOR_RE =
  /(?:^|\/)(?:node_modules|vendor|third_party|third-party|bower_components)(?:\/|$)/i;
const GENERATED_RE =
  /(?:^|\/)(?:dist|build|coverage|out|generated|gen)(?:\/|$)|(?:\.generated\.|\.gen\.)/i;

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  object: string;
}
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

async function git(
  repoPath: string,
  args: string[],
  encoding: 'utf8' | 'buffer' = 'utf8',
): Promise<Buffer | string> {
  const result = await execFileAsync('git', ['-C', repoPath, '--literal-pathspecs', ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

function text(value: Buffer | string): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}

async function ref(repoPath: string, name: string): Promise<string> {
  if (!name || name.startsWith('-')) throw new Error(`Invalid Git ref: ${name}`);
  return text(await git(repoPath, ['rev-parse', '--verify', `${name}^{commit}`])).trim();
}

async function tree(repoPath: string, revision: string): Promise<TreeEntry[]> {
  const raw = Buffer.from(await git(repoPath, ['ls-tree', '-r', '-z', '--full-tree', revision]));
  const result: TreeEntry[] = [];
  for (const record of raw.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, object] = record.slice(0, tab).split(/\s+/);
    result.push({ mode, type, object, path: record.slice(tab + 1) });
  }
  return result.sort((a, b) => compare(a.path, b.path));
}
async function modeAt(
  repoPath: string,
  revision: string,
  path: string,
): Promise<string | undefined> {
  try {
    const raw = text(await git(repoPath, ['ls-tree', '-z', revision, '--', path]));
    const first = raw.split('\0').find(Boolean);
    return first?.slice(0, first.indexOf('\t')).split(/\s+/)[0];
  } catch {
    return undefined;
  }
}

function isRelevantPath(path: string): boolean {
  return !VENDOR_RE.test(path) && !GENERATED_RE.test(path) && !isSecret(path);
}

function isSecret(path: string): boolean {
  return SECRET_RE.test(path.split('/').pop() ?? path);
}

function isUtf8Text(data: Buffer): boolean {
  if (data.includes(0)) return false;
  return Buffer.from(data.toString('utf8'), 'utf8').equals(data);
}

function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) return value.endsWith('\t') ? value.slice(0, -1) : value;
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '\\': 92,
    '"': 34,
  };
  for (let index = 1; index < value.length; index++) {
    const character = value[index];
    if (character === '"') break;
    if (character !== '\\') {
      const codePoint = value.codePointAt(index)!;
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint)));
      if (codePoint > 0xffff) index++;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) break;
    const octal = value.slice(index).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length - 1;
    } else bytes.push(escapes[escaped] ?? escaped.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseHunks(diff: string): Map<string, DiffHunk[]> {
  const result = new Map<string, DiffHunk[]>();
  let current: string | undefined;
  let oldPath: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      const path = decodeGitPath(line.slice(4));
      oldPath = path.startsWith('a/') ? path.slice(2) : path === '/dev/null' ? undefined : path;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = decodeGitPath(line.slice(4));
      current = path === '/dev/null' ? oldPath : path.startsWith('b/') ? path.slice(2) : path;
      if (current && !result.has(current)) result.set(current, []);
      continue;
    }
    const match =
      /^@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@/.exec(
        line,
      );
    if (match && current) {
      result.get(current)!.push({
        oldStart: Number(match.groups!.oldStart),
        oldLines: Number(match.groups!.oldLines ?? 1),
        newStart: Number(match.groups!.newStart),
        newLines: Number(match.groups!.newLines ?? 1),
      });
    }
  }
  return result;
}

async function changedFiles(
  repoPath: string,
  mergeBase: string,
  head: string,
  diff: string,
  inspectContent = true,
): Promise<ChangedFile[]> {
  const raw = Buffer.from(
    await git(repoPath, [
      '-c',
      'diff.renames=true',
      'diff',
      '--name-status',
      '--find-renames=50%',
      '--no-ext-diff',
      '--no-textconv',
      '-z',
      mergeBase,
      head,
      '--',
    ]),
  );
  const fields = raw.toString('utf8').split('\0').filter(Boolean);
  const hunks = parseHunks(diff);
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const letter = status[0];
    const oldPath = letter === 'R' || letter === 'C' ? fields[i++] : undefined;
    const path = fields[i++];
    if (!path) continue;
    const normalizedStatus =
      letter === 'A'
        ? 'added'
        : letter === 'D'
          ? 'deleted'
          : letter === 'R'
            ? 'renamed'
            : 'modified';
    if (!inspectContent || !isRelevantPath(path) || Boolean(oldPath && !isRelevantPath(oldPath))) {
      files.push({
        path,
        ...(oldPath ? { oldPath } : {}),
        status: normalizedStatus,
        binary: false,
        hunks: hunks.get(path) ?? [],
      });
      continue;
    }
    let binary = false;
    try {
      const modeRevision = normalizedStatus === 'deleted' ? mergeBase : head;
      const modePath = normalizedStatus === 'deleted' ? (oldPath ?? path) : path;
      if ((await modeAt(repoPath, modeRevision, modePath)) === '120000') {
        binary = true;
        files.push({
          path,
          ...(oldPath ? { oldPath } : {}),
          status: normalizedStatus,
          binary,
          hunks: hunks.get(path) ?? [],
        });
        continue;
      }
      const type = text(await git(repoPath, ['cat-file', '-t', `${head}:${path}`])).trim();
      if (type !== 'blob') binary = true;
      else
        binary = !isUtf8Text(
          Buffer.from(await git(repoPath, ['show', `${head}:${path}`], 'buffer')),
        );
    } catch {
      if (normalizedStatus === 'deleted') {
        const basePath = oldPath ?? path;
        try {
          binary =
            (await modeAt(repoPath, mergeBase, basePath)) === '120000' ||
            !isUtf8Text(
              Buffer.from(await git(repoPath, ['show', `${mergeBase}:${basePath}`], 'buffer')),
            );
        } catch {
          binary = true;
        }
      }
    }
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status: normalizedStatus,
      binary,
      hunks: hunks.get(path) ?? [],
    });
  }
  return files.sort((a, b) => compare(a.path, b.path));
}

async function immutableSources(
  repoPath: string,
  revision: string,
  changedPaths: Set<string>,
): Promise<{ sources: Record<string, string>; skipped: string[] }> {
  const entries = await tree(repoPath, revision);
  const sources: Record<string, string> = {};
  const skipped: string[] = [];
  const manifests = entries.filter(
    (entry) => entry.path === 'package.json' || entry.path.endsWith('/package.json'),
  );
  const relevantManifests = new Set<string>();
  for (const changedPath of changedPaths) {
    const ancestors = manifests
      .filter((entry) =>
        changedPath.startsWith(
          entry.path === 'package.json' ? '' : entry.path.slice(0, -'package.json'.length),
        ),
      )
      .sort((a, b) => b.path.length - a.path.length || compare(a.path, b.path));
    if (ancestors[0]) relevantManifests.add(ancestors[0].path);
  }
  for (const entry of entries) {
    if (!isRelevantPath(entry.path)) {
      if (changedPaths.has(entry.path))
        skipped.push(`${entry.path}: excluded vendor, generated, or secret path`);
      continue;
    }
    if (entry.mode === '120000' || entry.type !== 'blob') {
      skipped.push(`${entry.path}: symlink or non-blob`);
      continue;
    }
    const eligible =
      changedPaths.has(entry.path) ||
      CODE_RE.test(entry.path) ||
      CONFIG_RE.test(entry.path) ||
      relevantManifests.has(entry.path);
    if (!eligible) continue;
    const data = Buffer.from(await git(repoPath, ['show', `${revision}:${entry.path}`], 'buffer'));
    if (!isUtf8Text(data)) {
      skipped.push(`${entry.path}: binary or invalid UTF-8`);
      continue;
    }
    sources[entry.path] = data.toString('utf8');
  }
  return { sources, skipped };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function validateRepository(
  repoPath: string,
): Promise<{ path: string; name: string }> {
  const candidate = resolve(repoPath);
  let top: string;
  try {
    top = text(await git(candidate, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new Error(`Not a Git repository: ${repoPath}`);
  }
  return { path: resolve(top), name: basename(resolve(top)) };
}

export async function snapshot(repoPath: string, base: string, head: string): Promise<Snapshot> {
  const validated = await validateRepository(repoPath);
  const pinnedBase = await ref(validated.path, base);
  const pinnedHead = await ref(validated.path, head);
  const mergeBase = text(await git(validated.path, ['merge-base', pinnedBase, pinnedHead])).trim();
  const preliminaryFiles = await changedFiles(validated.path, mergeBase, pinnedHead, '', false);
  const changedPaths = new Set(
    preliminaryFiles.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]),
  );
  const symlinks = new Set<string>();
  for (const file of preliminaryFiles) {
    const headSymlink =
      file.status !== 'deleted' &&
      (await modeAt(validated.path, pinnedHead, file.path)) === '120000';
    const basePath = file.oldPath ?? file.path;
    const baseSymlink =
      file.status !== 'added' && (await modeAt(validated.path, mergeBase, basePath)) === '120000';
    if (headSymlink || baseSymlink) symlinks.add(file.path);
  }
  const allowedPaths = preliminaryFiles
    .filter(
      (file) =>
        !symlinks.has(file.path) &&
        isRelevantPath(file.path) &&
        (!file.oldPath || isRelevantPath(file.oldPath)),
    )
    .flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]);
  const diffArgs = [
    '-c',
    'core.quotePath=false',
    '-c',
    'diff.algorithm=myers',
    '-c',
    'diff.indentHeuristic=false',
    '-c',
    'diff.renames=true',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames=50%',
    '--diff-algorithm=myers',
    '--no-indent-heuristic',
    '--unified=3',
    '--no-color',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    mergeBase,
    pinnedHead,
    '--',
    ...allowedPaths,
  ];
  const diff = allowedPaths.length ? text(await git(validated.path, diffArgs)) : '';
  const files = await changedFiles(validated.path, mergeBase, pinnedHead, diff);
  const baseData = await immutableSources(validated.path, mergeBase, changedPaths);
  const headData = await immutableSources(validated.path, pinnedHead, changedPaths);
  const limitations = [
    ...new Set([
      ...[...changedPaths]
        .filter((path) => !isRelevantPath(path))
        .map((path) => `Skipped changed path ${path}: vendor, generated, or secret file.`),
      ...baseData.skipped
        .filter((item) => changedPaths.has(item.slice(0, item.lastIndexOf(': '))))
        .map((item) => `Skipped ${item}`),
      ...headData.skipped
        .filter((item) => changedPaths.has(item.slice(0, item.lastIndexOf(': '))))
        .map((item) => `Skipped ${item}`),
      ...(files.some((file) => file.binary)
        ? [
            'Binary or non-source changed files are represented in the diff but have no source context.',
          ]
        : []),
    ]),
  ].sort(compare);
  const identity = {
    base: pinnedBase,
    head: pinnedHead,
    mergeBase,
    diff,
    files,
    sources: { base: baseData.sources, head: headData.sources },
    limitations,
  };
  return {
    id: digest(identity),
    repoPath: validated.path,
    base: pinnedBase,
    head: pinnedHead,
    mergeBase,
    diff,
    files,
    sources: { base: baseData.sources, head: headData.sources },
    limitations,
  };
}
