import type {
  ContextPacket,
  Feedback,
  JudgmentPack,
  RepositoryRecord,
  Run,
  RunEvent,
  RunStatus,
} from '../../../../src/types';

export type View = 'workspace' | 'repositories' | 'packs';
export type RunTab = 'findings' | 'context' | 'activity' | 'packs';
export type Notice = { kind: 'error' | 'success'; text: string };

export type StationState = {
  repos: RepositoryRecord[];
  runs: Run[];
  packs: JudgmentPack[];
  settings: { maxWorkers: number };
  models: { provider: string; id: string; name: string }[];
  modelError?: string;
};

export type RunDetail = {
  run: Run;
  context: ContextPacket | null;
  events: RunEvent[];
  feedback: Feedback[];
};

export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  needs_input: 'Needs input',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export const STATUS_TONES: Record<RunStatus, string> = {
  queued: 'queued',
  running: 'running',
  needs_input: 'needs-input',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

export function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function timeAgo(value?: string) {
  if (!value) return '—';
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta)) return '—';
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function displayRef(value: string) {
  if (/^[0-9a-f]{12,}$/i.test(value)) return `${value.slice(0, 8)}…`;
  if (value.length > 28) return `${value.slice(0, 25)}…`;
  return value;
}

export function modelOptionKey(item: { provider: string; id: string }) {
  return JSON.stringify([item.provider, item.id]);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* response was not JSON */
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function labelize(value: string) {
  return value.replace(/_/g, ' ').replace(/^\w/, (char) => char.toUpperCase());
}
