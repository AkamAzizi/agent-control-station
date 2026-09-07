import { createHash } from 'node:crypto';
import ts from 'typescript';
import {
  ContextItem,
  ContextManifest,
  ContextPacket,
  ContextPolicy,
  DEFAULT_POLICY,
  JudgmentPack,
  Side,
  Snapshot,
  SymbolRecord,
} from '../types.js';

const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const TEST_RE = /(?:^|\/)(?:__tests__\/|tests?\/)|(?:\.(?:test|spec))\.[cm]?[jt]sx?$/i;
const CONTEXT_IMPLEMENTATION_VERSION = 'station-context/1';

interface Decl {
  key: string;
  id: string;
  name: string;
  path: string;
  side: Side;
  node: ts.Node;
  source: ts.SourceFile;
  startLine: number;
  endLine: number;
  exported: boolean;
}
interface Analysis {
  declarations: Decl[];
  records: SymbolRecord[];
  imports: Map<string, string[]>;
  unresolved: string[];
  owners: Map<string, Decl>;
}
interface Candidate {
  item: ContextItem;
  mandatory: boolean;
  priority: number;
}

const utf8 = (value: string): number => Buffer.byteLength(value, 'utf8');
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const virtualPath = (path: string): string => `/__snapshot__/${path}`;
const relativeVirtual = (path: string): string => path.replace(/^\/__snapshot__\//, '');
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}
function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
function joinPath(base: string, value: string): string {
  return normalizePath(base ? `${base}/${value}` : value);
}

function isSource(path: string): boolean {
  return TS_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}
function tsExtension(path: string): ts.Extension {
  return path.endsWith('.tsx')
    ? ts.Extension.Tsx
    : path.endsWith('.jsx')
      ? ts.Extension.Jsx
      : path.endsWith('.json')
        ? ts.Extension.Json
        : path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')
          ? ts.Extension.Js
          : ts.Extension.Ts;
}
function lineRange(source: ts.SourceFile, node: ts.Node): [number, number] {
  return [
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    source.getLineAndCharacterOfPosition(node.end).line + 1,
  ];
}
function declarationName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  )
    return node.name?.text;
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
    return node.name && ts.isIdentifier(node.name) ? node.name.text : node.name?.getText();
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}
function declarationNameNode(
  node: ts.Node,
): ts.Identifier | ts.StringLiteral | ts.PrivateIdentifier | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  )
    return node.name;
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name &&
    (ts.isIdentifier(node.name) ||
      ts.isStringLiteral(node.name) ||
      ts.isPrivateIdentifier(node.name))
  )
    return node.name;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name;
  return undefined;
}
function isDeclaration(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isVariableDeclaration(node)
  );
}
function isExported(node: ts.Node): boolean {
  const target =
    ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
      ? node.parent.parent
      : node;
  return !!(
    ts.canHaveModifiers(target) &&
    ts
      .getModifiers(target)
      ?.some(
        (mod) =>
          mod.kind === ts.SyntaxKind.ExportKeyword || mod.kind === ts.SyntaxKind.DefaultKeyword,
      )
  );
}
function sourceFiles(sources: Record<string, string>): string[] {
  return Object.keys(sources).filter(isSource).sort(compare);
}
interface AliasConfig {
  configDir: string;
  configPath: string;
  patterns: { pattern: string; targets: string[] }[];
}
function configAliases(sources: Record<string, string>): AliasConfig[] {
  interface ResolvedConfig {
    baseUrl: string;
    patterns: Map<string, string[]>;
  }
  const configs = new Map<string, ResolvedConfig>();
  const files = Object.keys(sources)
    .filter((path) => /(?:^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(path))
    .sort(compare);
  const parse = (path: string, stack: Set<string>): ResolvedConfig => {
    const existing = configs.get(path);
    if (existing) return existing;
    const configDir = dirname(path);
    if (stack.has(path)) return { baseUrl: configDir, patterns: new Map() };
    const parsed = ts.parseConfigFileTextToJson(path, sources[path] ?? '').config as
      Record<string, unknown> | undefined;
    if (!parsed) return { baseUrl: configDir, patterns: new Map() };
    const base = typeof parsed.extends === 'string' ? parsed.extends : undefined;
    let inherited: ResolvedConfig = { baseUrl: configDir, patterns: new Map() };
    if (base) {
      let parent = base.startsWith('.') ? joinPath(configDir, base) : '';
      if (parent) {
        if (!parent.endsWith('.json')) parent += '.json';
        if (sources[parent] !== undefined) inherited = parse(parent, new Set([...stack, path]));
      }
    }
    const options = parsed.compilerOptions as { baseUrl?: unknown; paths?: unknown } | undefined;
    const baseUrl =
      typeof options?.baseUrl === 'string'
        ? joinPath(configDir, options.baseUrl)
        : inherited.baseUrl;
    const patterns = new Map(inherited.patterns);
    if (options?.paths && typeof options.paths === 'object') {
      for (const [pattern, rawTargets] of Object.entries(
        options.paths as Record<string, unknown>,
      )) {
        if (!Array.isArray(rawTargets)) continue;
        patterns.set(
          pattern,
          rawTargets
            .filter((target): target is string => typeof target === 'string')
            .map((target) => joinPath(baseUrl, target)),
        );
      }
    }
    const resolved = { baseUrl, patterns };
    configs.set(path, resolved);
    return resolved;
  };
  const result: AliasConfig[] = [];
  for (const path of files) {
    const config = parse(path, new Set());
    const configDir = dirname(path);
    const patterns = [...config.patterns].map(([pattern, targets]) => ({ pattern, targets }));
    if (patterns.length) result.push({ configDir, configPath: path, patterns });
  }
  return result;
}

function hostFor(sources: Record<string, string>, configs: AliasConfig[]): ts.CompilerHost {
  const names = new Map(sourceFiles(sources).map((path) => [virtualPath(path), path]));
  const opts: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(opts, true);
  host.fileExists = (file) => names.has(file) || (file.endsWith('.d.ts') && names.has(file));
  host.readFile = (file) => {
    const path = names.get(file);
    return path ? sources[path] : undefined;
  };
  host.getSourceFile = (file, languageVersion) => {
    const path = names.get(file);
    return path ? ts.createSourceFile(file, sources[path], languageVersion, true) : undefined;
  };
  host.getCurrentDirectory = () => '/__snapshot__';
  host.getCanonicalFileName = (file) => file;
  host.getDefaultLibFileName = () => '/__snapshot__/lib.d.ts';
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((specifier) => {
      const resolved = resolveImport(
        relativeVirtual(containingFile),
        specifier,
        new Set(names.values()),
        configs,
      );
      return resolved
        ? { resolvedFileName: virtualPath(resolved), extension: tsExtension(resolved) }
        : undefined;
    });
  return host;
}

function aliasConfigFor(importer: string, configs: AliasConfig[]): AliasConfig | undefined {
  const rank = (path: string): number =>
    /(?:^|\/)tsconfig\.json$/i.test(path) ? 0 : /(?:^|\/)jsconfig\.json$/i.test(path) ? 1 : 2;
  return configs
    .filter(
      (candidate) =>
        !candidate.configDir ||
        importer === candidate.configDir ||
        importer.startsWith(`${candidate.configDir}/`),
    )
    .sort(
      (a, b) =>
        b.configDir.length - a.configDir.length ||
        rank(a.configPath) - rank(b.configPath) ||
        compare(a.configPath, b.configPath),
    )[0];
}

function resolveImport(
  importer: string,
  specifier: string,
  sourcePaths: Set<string>,
  configs: AliasConfig[],
): string | undefined {
  const config = aliasConfigFor(importer, configs);
  const alias = config?.patterns.find((candidate) => {
    const star = candidate.pattern.indexOf('*');
    return star < 0
      ? candidate.pattern === specifier
      : specifier.startsWith(candidate.pattern.slice(0, star)) &&
          specifier.endsWith(candidate.pattern.slice(star + 1));
  });
  if (
    !specifier.startsWith('.') &&
    !specifier.startsWith('@/') &&
    !specifier.startsWith('~/') &&
    !alias
  )
    return undefined;
  const star = alias?.pattern.indexOf('*') ?? -1;
  const capture =
    alias && star >= 0
      ? specifier.slice(star, specifier.length - alias.pattern.slice(star + 1).length)
      : '';
  const aliasTarget = alias?.targets.find((target) => {
    const candidate = target.includes('*') ? target.replace('*', capture) : target;
    const noRuntime = candidate.replace(/\.(?:mjs|cjs|jsx?|mts|cts)$/i, '');
    return [
      candidate,
      noRuntime,
      ...TS_EXTENSIONS.map((ext) => candidate + ext),
      ...TS_EXTENSIONS.map((ext) => noRuntime + ext),
      ...TS_EXTENSIONS.map((ext) => `${candidate}/index${ext}`),
    ].some((path) => sourcePaths.has(path));
  });
  const expandedAlias = aliasTarget
    ? aliasTarget.includes('*')
      ? aliasTarget.replace('*', capture)
      : aliasTarget
    : undefined;
  const base = specifier.startsWith('.')
    ? joinPath(dirname(importer), specifier)
    : (expandedAlias ?? specifier.slice(2));
  const normalized = normalizePath(base);
  const withoutRuntimeExtension = normalized.replace(/\.(?:mjs|cjs|jsx?|mts|cts)$/i, '');
  const candidates = [
    normalized,
    withoutRuntimeExtension,
    ...TS_EXTENSIONS.map((ext) => normalized + ext),
    ...TS_EXTENSIONS.map((ext) => withoutRuntimeExtension + ext),
    ...TS_EXTENSIONS.map((ext) => `${normalized}/index${ext}`),
    ...TS_EXTENSIONS.map((ext) => `${withoutRuntimeExtension}/index${ext}`),
  ];
  for (const candidate of candidates) if (sourcePaths.has(candidate)) return candidate;
  return undefined;
}

function matchesAlias(pattern: string, specifier: string): boolean {
  const star = pattern.indexOf('*');
  return star < 0
    ? pattern === specifier
    : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
}

function analyze(sources: Record<string, string>, side: Side): Analysis {
  const paths = sourceFiles(sources);
  const pathSet = new Set(paths);
  const aliases = configAliases(sources);
  const programs = ts.createProgram(
    paths.map(virtualPath),
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      noLib: true,
      skipLibCheck: true,
    },
    hostFor(sources, aliases),
  );
  const checker = programs.getTypeChecker();
  const declarations: Decl[] = [];
  const imports = new Map<string, string[]>();
  const unresolved: string[] = [];
  const owners = new Map<string, Decl>();
  for (const path of paths) {
    const source = programs.getSourceFile(virtualPath(path));
    if (!source) continue;
    const local: Decl[] = [];
    const visit = (node: ts.Node): void => {
      if (isDeclaration(node)) {
        const name = declarationName(node);
        if (name) {
          const [startLine, endLine] = lineRange(source, node);
          const key = `${side}:${path}:${node.getStart(source)}:${name}`;
          const decl: Decl = {
            key,
            id: hash({ side, path, startLine, endLine, name }).slice(0, 20),
            name,
            path,
            side,
            node,
            source,
            startLine,
            endLine,
            exported: isExported(node),
          };
          declarations.push(decl);
          local.push(decl);
          owners.set(key, decl);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    // Keep the smallest declaration for nested methods only when names/positions differ.
    for (const decl of local) if (!owners.has(decl.key)) owners.set(decl.key, decl);
    const deps: string[] = [];
    const importVisitor = (node: ts.Node): void => {
      let specifier: string | undefined;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
        specifier = node.moduleSpecifier.text;
      else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text;
      else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      )
        specifier = node.moduleReference.expression.text;
      if (specifier) {
        const resolved = resolveImport(path, specifier, pathSet, aliases);
        const configuredAlias =
          aliasConfigFor(path, aliases)?.patterns.some((candidate) =>
            matchesAlias(candidate.pattern, specifier!),
          ) ?? false;
        if (resolved) deps.push(resolved);
        else if (
          specifier.startsWith('.') ||
          specifier.startsWith('@/') ||
          specifier.startsWith('~/') ||
          configuredAlias
        )
          unresolved.push(`${path}: ${specifier}`);
      }
      ts.forEachChild(node, importVisitor);
    };
    importVisitor(source);
    imports.set(path, [...new Set(deps)].sort(compare));
  }
  const symbolDecl = new Map<ts.Symbol, Decl>();
  for (const decl of declarations) {
    const nameNode = declarationNameNode(decl.node);
    if (nameNode) {
      const symbol = checker.getSymbolAtLocation(nameNode);
      if (symbol)
        symbolDecl.set(
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
          decl,
        );
    }
  }
  for (const path of paths) {
    const source = programs.getSourceFile(virtualPath(path));
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      let symbol = exported;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        try {
          symbol = checker.getAliasedSymbol(symbol);
        } catch {
          continue;
        }
      }
      const target = symbolDecl.get(symbol);
      if (target) target.exported = true;
    }
  }
  const records = declarations
    .map((decl) => {
      const refs = new Set<string>();
      const walk = (node: ts.Node): void => {
        // Nested functions/methods own their call graph. Variable declarations do not:
        // their initializers are part of the containing function's execution.
        if (node !== decl.node && isDeclaration(node) && !ts.isVariableDeclaration(node)) return;
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const callee = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name
            : node.expression;
          let symbol = checker.getSymbolAtLocation(callee);
          if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) {
            try {
              symbol = checker.getAliasedSymbol(symbol);
            } catch {
              /* unresolved alias */
            }
          }
          const target = symbol ? symbolDecl.get(symbol) : undefined;
          if (target && target !== decl) refs.add(target.id);
        }
        ts.forEachChild(node, walk);
      };
      walk(decl.node);
      return {
        id: decl.id,
        name: decl.name,
        path: decl.path,
        side: decl.side,
        startLine: decl.startLine,
        endLine: decl.endLine,
        exported: decl.exported,
        references: [...refs].sort(compare),
      };
    })
    .sort(
      (a, b) =>
        compare(a.path, b.path) ||
        a.startLine - b.startLine ||
        compare(a.name, b.name) ||
        compare(a.id, b.id),
    );
  return {
    declarations,
    records,
    imports,
    unresolved: [...new Set(unresolved)].sort(compare),
    owners,
  };
}

function globMatch(path: string, glob: string): boolean {
  const parts = glob.trim().replace(/\\/g, '/').split('/');
  let expression = '^';
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === '**') {
      expression += '(?:[^/]+/)*';
      if (index < parts.length - 1 && parts[index + 1] === '') index++;
      continue;
    }
    const escaped = part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    expression += escaped;
    if (index < parts.length - 1) expression += '/';
  }
  try {
    return new RegExp(`${expression}$`).test(path);
  } catch {
    return false;
  }
}
function inScope(path: string, scopes?: string[]): boolean {
  if (!scopes?.length) return true;
  return scopes.some((scope) => path === scope || path.startsWith(`${scope.replace(/\/$/, '')}/`));
}
function changedLines(snapshot: Snapshot, path: string, side: Side): DiffHunkLike[] {
  const file = snapshot.files.find((item) => item.path === path || item.oldPath === path);
  return (file?.hunks ?? []).map((hunk) => ({
    start: side === 'base' ? hunk.oldStart : hunk.newStart,
    end: side === 'base' ? hunk.oldStart + hunk.oldLines - 1 : hunk.newStart + hunk.newLines - 1,
  }));
}
interface DiffHunkLike {
  start: number;
  end: number;
}
function overlaps(decl: Decl, hunks: DiffHunkLike[]): boolean {
  return (
    hunks.length === 0 ||
    hunks.some((hunk) => decl.endLine >= hunk.start && decl.startLine <= hunk.end)
  );
}
function declarationContent(decl: Decl): string {
  return decl.source.text.slice(decl.node.getStart(decl.source), decl.node.end);
}
function itemId(snapshot: Snapshot, item: Omit<ContextItem, 'id'>): string {
  return hash({
    snapshotId: snapshot.id,
    path: item.path,
    side: item.side,
    startLine: item.startLine,
    endLine: item.endLine,
    symbol: item.symbol,
    content: item.content,
  }).slice(0, 24);
}
function scopedDiff(snapshot: Snapshot, scopes?: string[]): string {
  const { diff } = snapshot;
  if (!scopes?.length) return diff;
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .filter((section) => {
      const file = snapshot.files.find((candidate) =>
        section.startsWith(
          `diff --git a/${candidate.oldPath ?? candidate.path} b/${candidate.path}\n`,
        ),
      );
      return (
        file &&
        (inScope(file.path, scopes) || Boolean(file.oldPath && inScope(file.oldPath, scopes)))
      );
    })
    .join('');
}
function renderPrompt(task: string, packText: string, items: ContextItem[]): string {
  return [
    task,
    packText ? `Judgment packs:\n${packText}` : '',
    ...items.map(
      (item) =>
        `\n[${item.id}] ${item.path} (${item.side}:${item.startLine}-${item.endLine})\n${item.content}`,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function closestPackageMetadata(
  snapshot: Snapshot,
  changedPaths: Set<string>,
): { path: string; side: Side; content: string }[] {
  const result = new Map<string, { path: string; side: Side; content: string }>();
  const available = new Set(
    [...Object.keys(snapshot.sources.base), ...Object.keys(snapshot.sources.head)].filter(
      (path) => path === 'package.json' || path.endsWith('/package.json'),
    ),
  );
  for (const changedPath of [...changedPaths].sort(compare)) {
    let directory = dirname(changedPath);
    let manifest: string | undefined;
    while (true) {
      const candidate = directory ? `${directory}/package.json` : 'package.json';
      if (available.has(candidate)) {
        manifest = candidate;
        break;
      }
      if (!directory) break;
      directory = dirname(directory);
    }
    if (!manifest || result.has(manifest)) continue;
    const side: Side = snapshot.sources.head[manifest] !== undefined ? 'head' : 'base';
    const raw = snapshot.sources[side][manifest];
    const parsed = ts.parseConfigFileTextToJson(manifest, raw).config as
      Record<string, unknown> | undefined;
    if (
      !parsed ||
      !['main', 'module', 'types', 'exports', 'imports', 'browser', 'bin'].some(
        (key) => parsed[key] !== undefined,
      )
    )
      continue;
    result.set(manifest, { path: manifest, side, content: raw });
  }
  return [...result.values()].sort((a, b) => compare(a.path, b.path));
}

function importsAny(imports: Map<string, string[]>, start: string, targets: Set<string>): boolean {
  const pending = [...(imports.get(start) ?? [])];
  const seen = new Set<string>();
  while (pending.length) {
    const path = pending.shift()!;
    if (targets.has(path)) return true;
    if (seen.has(path)) continue;
    seen.add(path);
    pending.push(...(imports.get(path) ?? []));
  }
  return false;
}

export function compile(
  snapshot: Snapshot,
  task: string,
  policyOverrides: Partial<ContextPolicy> = {},
  packs: JudgmentPack[] = [],
  scopePaths?: string[],
): ContextPacket {
  const policy: ContextPolicy = { ...DEFAULT_POLICY, ...policyOverrides };
  const limitations = [
    ...snapshot.limitations,
    'Symbol and call relationships use deterministic static syntax analysis; dynamic dispatch and runtime behavior are not resolved.',
    'Virtual compilation applies NodeNext resolution and repository path aliases; other tsconfig compiler options are not applied.',
  ];
  if (scopePaths?.length) {
    limitations.push(
      `Partial scope: analysis limited to ${[...scopePaths].sort(compare).join(', ')}.`,
    );
    limitations.push(
      'Strict scope excludes dependencies, tests, and package metadata outside the requested paths.',
    );
  }
  const base = analyze(snapshot.sources.base, 'base');
  const head = analyze(snapshot.sources.head, 'head');
  const changed = snapshot.files.flatMap((file) => [
    file.path,
    ...(file.oldPath ? [file.oldPath] : []),
  ]);
  const changedSet = new Set(changed);
  const selectedPaths = new Set(changed.filter((path) => inScope(path, scopePaths)));
  const candidates: Candidate[] = [];
  const add = (item: Omit<ContextItem, 'id'>, mandatory: boolean, priority: number): void => {
    candidates.push({ item: { ...item, id: itemId(snapshot, item) }, mandatory, priority });
  };
  const reviewDiff = scopedDiff(snapshot, scopePaths);
  const scopeHasNoDiff = Boolean(scopePaths?.length && snapshot.diff && !reviewDiff);
  if (scopeHasNoDiff)
    limitations.push(
      'The requested scope excludes every changed diff section; input is required to review a different scope.',
    );
  add(
    {
      path: '__diff__.patch',
      side: 'head',
      startLine: 1,
      endLine: Math.max(1, reviewDiff.split('\n').length),
      content: reviewDiff,
      reason: 'mandatory review diff',
      via: 'snapshot diff',
    },
    true,
    0,
  );
  for (const analysis of [base, head]) {
    for (const decl of analysis.declarations) {
      if (
        !selectedPaths.has(decl.path) ||
        (analysis === base ? head.declarations : base.declarations).some(
          (other) =>
            other.path === decl.path &&
            other.name === decl.name &&
            declarationContent(other) === declarationContent(decl),
        ) ||
        !overlaps(decl, changedLines(snapshot, decl.path, analysis === base ? 'base' : 'head'))
      )
        continue;
      const content = decl.source.text.slice(decl.node.getStart(decl.source), decl.node.end);
      add(
        {
          path: decl.path,
          side: decl.side,
          startLine: decl.startLine,
          endLine: decl.endLine,
          symbol: decl.name,
          content,
          reason: 'changed definition',
          via: `${decl.side} changed hunk`,
        },
        true,
        10,
      );
    }
  }
  for (const analysis of [base, head]) {
    const recordsById = new Map(analysis.records.map((record) => [record.id, record]));
    const changedIds = new Set(
      analysis.records
        .filter(
          (record) =>
            selectedPaths.has(record.path) &&
            !(analysis === base ? head : base).declarations.some(
              (other) =>
                other.path === record.path &&
                other.name === record.name &&
                declarationContent(other) ===
                  declarationContent(analysis.declarations.find((decl) => decl.id === record.id)!),
            ) &&
            overlaps(
              analysis.declarations.find((decl) => decl.id === record.id)!,
              changedLines(snapshot, record.path, analysis === base ? 'base' : 'head'),
            ),
        )
        .map((record) => record.id),
    );
    for (const record of analysis.records) {
      if (
        selectedPaths.has(record.path) ||
        !inScope(record.path, scopePaths) ||
        !record.references.some((reference) => changedIds.has(reference))
      )
        continue;
      const target = record.references.find((reference) => changedIds.has(reference));
      add(
        {
          path: record.path,
          side: record.side,
          startLine: record.startLine,
          endLine: record.endLine,
          symbol: record.name,
          content:
            analysis.declarations
              .find((decl) => decl.id === record.id)
              ?.source.text.slice(
                analysis.declarations
                  .find((decl) => decl.id === record.id)!
                  .node.getStart(
                    analysis.declarations.find((decl) => decl.id === record.id)!.source,
                  ),
                analysis.declarations.find((decl) => decl.id === record.id)!.node.end,
              ) ?? '',
          reason: 'caller of changed symbol',
          via: target
            ? `${record.path} references ${recordsById.get(target)?.name ?? target}`
            : 'call graph',
        },
        false,
        25,
      );
    }
  }
  // Follow only symbols actually referenced by changed declarations. This is bounded by dependencyDepth.
  for (const analysis of [base, head]) {
    const byId = new Map(analysis.declarations.map((decl) => [decl.id, decl]));
    const changedIds = new Set(
      analysis.records
        .filter(
          (record) =>
            selectedPaths.has(record.path) &&
            !(analysis === base ? head.declarations : base.declarations).some(
              (other) =>
                other.path === record.path &&
                other.name === record.name &&
                declarationContent(other) ===
                  declarationContent(analysis.declarations.find((decl) => decl.id === record.id)!),
            ) &&
            overlaps(
              analysis.declarations.find((decl) => decl.id === record.id)!,
              changedLines(snapshot, record.path, analysis === base ? 'base' : 'head'),
            ),
        )
        .map((record) => record.id),
    );
    let frontier = analysis.records.filter((record) => changedIds.has(record.id));
    const seen = new Set<string>();
    for (let depth = 1; depth <= Math.max(0, Math.min(3, policy.dependencyDepth)); depth++) {
      const next: typeof frontier = [];
      for (const record of frontier) {
        for (const targetId of record.references) {
          if (seen.has(targetId)) continue;
          seen.add(targetId);
          const target = byId.get(targetId);
          if (!target || changedIds.has(target.id) || !inScope(target.path, scopePaths)) continue;
          const content = target.source.text.slice(
            target.node.getStart(target.source),
            target.node.end,
          );
          add(
            {
              path: target.path,
              side: target.side,
              startLine: target.startLine,
              endLine: target.endLine,
              symbol: target.name,
              content,
              reason: 'dependency of changed code',
              via: `${record.path}:${record.name} references ${target.name} (depth ${depth})`,
            },
            false,
            20 + depth * 5,
          );
          next.push(analysis.records.find((item) => item.id === target.id)!);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
  }
  if (!scopePaths?.length) {
    for (const metadata of closestPackageMetadata(snapshot, selectedPaths)) {
      add(
        {
          path: metadata.path,
          side: metadata.side,
          startLine: 1,
          endLine: metadata.content.split('\n').length,
          content: metadata.content,
          reason: 'package entrypoint metadata',
          via: 'closest package.json for changed code',
        },
        false,
        35,
      );
    }
  }
  for (const analysis of [base, head]) {
    for (const path of analysis.imports.keys())
      if (
        TEST_RE.test(path) &&
        inScope(path, scopePaths) &&
        importsAny(analysis.imports, path, selectedPaths)
      ) {
        const content = (analysis === head ? snapshot.sources.head : snapshot.sources.base)[path];
        if (content)
          add(
            {
              path,
              side: analysis === head ? 'head' : 'base',
              startLine: 1,
              endLine: content.split('\n').length,
              content,
              reason: 'test selection',
              via: 'test imports changed code',
            },
            false,
            40,
          );
      }
  }
  for (const path of changedSet)
    if (
      inScope(path, scopePaths) &&
      !(
        base.declarations.some((decl) => decl.path === path) ||
        head.declarations.some((decl) => decl.path === path)
      )
    ) {
      const side: Side = snapshot.sources.head[path] !== undefined ? 'head' : 'base';
      const content = snapshot.sources[side][path];
      if (content !== undefined)
        add(
          {
            path,
            side,
            startLine: 1,
            endLine: content.split('\n').length,
            content,
            reason: isSource(path)
              ? 'changed source without named symbols'
              : 'changed text fallback',
            via: 'changed file',
          },
          true,
          15,
        );
    }
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const old = unique.get(candidate.item.id);
    if (!old || candidate.priority < old.priority || (candidate.mandatory && !old.mandatory))
      unique.set(candidate.item.id, candidate);
  }
  const ordered = [...unique.values()].sort(
    (a, b) =>
      a.priority - b.priority ||
      compare(a.item.path, b.item.path) ||
      compare(a.item.side, b.item.side) ||
      a.item.startLine - b.item.startLine ||
      compare(a.item.symbol ?? '', b.item.symbol ?? '') ||
      compare(a.item.id, b.item.id),
  );
  const relevantPacks = new Map<string, JudgmentPack>();
  for (const pack of packs
    .filter((pack) => pack.active)
    .sort((a, b) => compare(a.id, b.id) || b.version - a.version)) {
    if (
      !relevantPacks.has(pack.id) &&
      [...selectedPaths].some((path) => pack.globs.some((glob) => globMatch(path, glob)))
    )
      relevantPacks.set(pack.id, pack);
  }
  const loadedPacks: JudgmentPack[] = [];
  const packBlocks: string[] = [];
  const packOmissions: { path: string; reason: string }[] = [];
  for (const pack of [...relevantPacks.values()].sort((a, b) => compare(a.id, b.id))) {
    const lines = [`Pack ${pack.id} v${pack.version} (${pack.name})`];
    for (const rule of [...pack.rules].sort((a, b) => compare(a.id, b.id)))
      lines.push(
        `- ${rule.id}: ${rule.text}${rule.goodExample ? ` Good: ${rule.goodExample}` : ''}${rule.badExample ? ` Bad: ${rule.badExample}` : ''}`,
      );
    const block = lines.join('\n');
    if (utf8([...packBlocks, block].join('\n')) <= Math.max(0, policy.maxPackBytes)) {
      packBlocks.push(block);
      loadedPacks.push(pack);
    } else
      packOmissions.push({
        path: `__pack__/${pack.id}@${pack.version}`,
        reason: 'judgment pack byte budget',
      });
  }
  const packText = packBlocks.join('\n');
  if (packOmissions.length)
    limitations.push(
      `Whole judgment packs exceeding the ${policy.maxPackBytes}-byte pack budget were omitted.`,
    );
  const selected: ContextItem[] = [];
  const omitted: { path: string; reason: string }[] = [...packOmissions];
  const mandatoryCandidates = ordered.filter((candidate) => candidate.mandatory);
  for (const candidate of mandatoryCandidates) selected.push(candidate.item);
  const mandatoryPrompt = renderPrompt(task, packText, selected);
  const mandatoryOverflow = utf8(mandatoryPrompt) > policy.maxBytes;
  let used = utf8(mandatoryPrompt);
  for (const candidate of ordered) {
    if (candidate.mandatory) continue;
    const candidatePrompt = renderPrompt(task, packText, [...selected, candidate.item]);
    if (utf8(candidatePrompt) <= policy.maxBytes) {
      selected.push(candidate.item);
      used = utf8(candidatePrompt);
    } else omitted.push({ path: candidate.item.path, reason: 'context byte budget' });
  }
  if (mandatoryOverflow)
    limitations.push(
      'Mandatory diff or changed definitions exceed the context budget; input is required rather than silently truncating them.',
    );
  if (base.unresolved.length || head.unresolved.length)
    limitations.push(
      `Unresolved imports: ${[...new Set([...base.unresolved, ...head.unresolved])].sort(compare).join(', ')}`,
    );
  if (!snapshot.files.length) limitations.push('No changes between the selected revisions.');
  const records = [...base.records, ...head.records].sort(
    (a, b) =>
      compare(a.side, b.side) ||
      compare(a.path, b.path) ||
      a.startLine - b.startLine ||
      compare(a.name, b.name) ||
      compare(a.id, b.id),
  );
  const manifest: ContextManifest = {
    version: 1,
    snapshotId: snapshot.id,
    compilerVersion: `${CONTEXT_IMPLEMENTATION_VERSION};typescript/${ts.version}`,
    policy,
    task,
    packs: loadedPacks.map((pack) => ({ id: pack.id, version: pack.version })),
    items: selected,
    omitted: omitted.sort((a, b) => compare(a.path, b.path) || compare(a.reason, b.reason)),
    limitations: [...new Set(limitations)].sort(compare),
  };
  const prompt = renderPrompt(task, packText, selected);
  const noReviewableChanges = snapshot.files.length === 0 || !snapshot.diff;
  if (noReviewableChanges)
    manifest.limitations = [
      ...new Set([
        ...manifest.limitations,
        snapshot.files.length
          ? 'All changed paths were excluded or outside the requested scope; input is required.'
          : 'No changed files are available for review; input is required.',
      ]),
    ].sort(compare);
  return {
    id: hash({
      snapshotId: snapshot.id,
      task,
      policy,
      compilerVersion: manifest.compilerVersion,
      contextImplementationVersion: CONTEXT_IMPLEMENTATION_VERSION,
      packs: manifest.packs,
      packText,
      items: selected,
      omitted: manifest.omitted,
      limitations: manifest.limitations,
      prompt,
    }).slice(0, 24),
    manifest,
    prompt,
    byteLength: utf8(prompt),
    estimatedTokens: Math.ceil(utf8(prompt) / 4),
    status: mandatoryOverflow || scopeHasNoDiff || noReviewableChanges ? 'needs_input' : 'ready',
    symbols: records,
  };
}
