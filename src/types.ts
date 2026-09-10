export type RunStatus =
  'queued' | 'running' | 'needs_input' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type StepName = 'snapshot' | 'context' | 'review' | 'verify' | 'result';
export type Side = 'base' | 'head';
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}
export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  hunks: DiffHunk[];
}
export interface Snapshot {
  id: string;
  repoPath: string;
  base: string;
  head: string;
  mergeBase: string;
  diff: string;
  files: ChangedFile[];
  sources: Record<Side, Record<string, string>>;
  limitations: string[];
}
export interface PackRule {
  id: string;
  text: string;
  goodExample?: string;
  badExample?: string;
  source?: string;
}
export interface JudgmentPack {
  id: string;
  version: number;
  name: string;
  active: boolean;
  globs: string[];
  roles: ('reviewer' | 'verifier')[];
  rules: PackRule[];
}
export interface ContextPolicy {
  maxBytes: number;
  maxPackBytes: number;
  dependencyDepth: number;
  maxToolCalls: number;
  timeoutMs: number;
}
export const DEFAULT_POLICY: ContextPolicy = {
  maxBytes: 768 * 1024,
  maxPackBytes: 8 * 1024,
  dependencyDepth: 1,
  maxToolCalls: 40,
  timeoutMs: 600_000,
};
export interface ContextItem {
  id: string;
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  symbol?: string;
  content: string;
  reason: string;
  via?: string;
}
export interface SymbolRecord {
  id: string;
  name: string;
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  exported: boolean;
  references: string[];
}
export interface ContextManifest {
  version: 1;
  snapshotId: string;
  compilerVersion: string;
  policy: ContextPolicy;
  task: string;
  packs: { id: string; version: number }[];
  items: ContextItem[];
  omitted: { path: string; reason: string }[];
  limitations: string[];
}
export interface ContextPacket {
  id: string;
  manifest: ContextManifest;
  prompt: string;
  byteLength: number;
  estimatedTokens: number;
  status: 'ready' | 'needs_input';
  symbols: SymbolRecord[];
}
export interface RepositoryRecord {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}
export interface ReviewRequest {
  repoId: string;
  base: string;
  head: string;
  task: string;
  runtime: 'scripted' | 'pi';
  provider?: string;
  model?: string;
  policy?: Partial<ContextPolicy>;
  scopePaths?: string[];
  demo?: boolean;
}
export interface Evidence {
  contextItemId: string;
  quote: string;
}
export interface Finding {
  id: string;
  title: string;
  body: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  evidence: Evidence[];
  disposition: 'pending' | 'supported' | 'rejected' | 'uncertain';
  verification?: string;
}
export interface PlanNode {
  name: StepName;
  status: RunStatus | 'skipped';
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  readBytes: number;
  cost: number | null;
}
export interface Run {
  id: string;
  title: string;
  repoId: string;
  repoName: string;
  request: ReviewRequest;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  previousRunId?: string;
  nodes: PlanNode[];
  findings: Finding[];
  usage: Usage;
  contextId?: string;
  snapshotId?: string;
  error?: string;
  limitations: string[];
  runtimeVersion?: string;
  model?: string;
  packSnapshot?: JudgmentPack[];
}
export interface RunEvent {
  id: number;
  runId: string;
  type: string;
  time: string;
  data: Record<string, unknown>;
}
export interface Feedback {
  id: string;
  runId: string;
  findingId: string;
  verdict: 'useful' | 'incorrect' | 'unclear';
  note: string;
  createdAt: string;
}
export interface WorkerSpec {
  runId: string;
  role: 'reviewer' | 'verifier';
  packet: ContextPacket;
  findings: Finding[];
  request: ReviewRequest;
  policy: ContextPolicy;
}
export type WorkerEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'result'; findings: Finding[]; incomplete?: string }
  | { type: 'metadata'; version: string; model: string };
export interface ScopedTools {
  read(input: { itemId: string; reason: string }): Promise<ContextItem>;
  lookup(input: { name: string; reason: string }): Promise<SymbolRecord[]>;
}
export interface Runner {
  run(spec: WorkerSpec, tools: ScopedTools, signal: AbortSignal): AsyncIterable<WorkerEvent>;
}
