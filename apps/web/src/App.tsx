import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Code2,
  Database,
  FileCode2,
  FolderGit2,
  GitBranch,
  Info,
  Layers3,
  LoaderCircle,
  Menu,
  MessageSquareText,
  PackageCheck,
  PanelLeft,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
  XCircle,
} from 'lucide-react';
import type {
  ContextItem,
  ContextPacket,
  Feedback,
  Finding,
  JudgmentPack,
  RepositoryRecord,
  ReviewRequest,
  Run,
  RunEvent,
  RunStatus,
} from '../../../src/types';

type View = 'workspace' | 'repositories' | 'packs';
type RunTab = 'findings' | 'context' | 'activity' | 'packs';
type Notice = { kind: 'error' | 'success'; text: string };

// State is exported by the API but intentionally kept local to the web package;
// the shared domain file only contains domain records and does not own transport types.
type StationState = {
  repos: RepositoryRecord[];
  runs: Run[];
  packs: JudgmentPack[];
  settings: { maxWorkers: number };
  models: { provider: string; id: string; name: string }[];
  modelError?: string;
};

type RunDetail = {
  run: Run;
  context: ContextPacket | null;
  events: RunEvent[];
  feedback: Feedback[];
};

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  needs_input: 'Needs input',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

const STATUS_TONES: Record<RunStatus, string> = {
  queued: 'queued',
  running: 'running',
  needs_input: 'needs-input',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

function formatDate(value?: string) {
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

function timeAgo(value?: string) {
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

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function displayRef(value: string) {
  if (/^[0-9a-f]{12,}$/i.test(value)) return `${value.slice(0, 8)}…`;
  if (value.length > 28) return `${value.slice(0, 25)}…`;
  return value;
}

function modelOptionKey(item: { provider: string; id: string }) {
  return JSON.stringify([item.provider, item.id]);
}

function statusIcon(status: RunStatus) {
  if (status === 'running') return <LoaderCircle size={14} className="spin" />;
  if (status === 'completed') return <CheckCircle2 size={14} />;
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted')
    return <XCircle size={14} />;
  return <CircleDot size={14} />;
}

function StatusPill({ status }: { status: RunStatus }) {
  return (
    <span className={`status-pill ${STATUS_TONES[status]}`}>
      {statusIcon(status)}
      {STATUS_LABELS[status]}
    </span>
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
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

function labelize(value: string) {
  return value.replace(/_/g, ' ').replace(/^\w/, (char) => char.toUpperCase());
}

function EmptyState({
  onDemo,
  onNew,
  demoBusy,
}: {
  onDemo: () => void;
  onNew: () => void;
  demoBusy?: boolean;
}) {
  return (
    <div className="empty-state">
      <div className="empty-mark">
        <Sparkles size={22} />
      </div>
      <h2>No reviews yet</h2>
      <p className="muted copy">
        Register a repository, then compare two refs with a task in plain language. History stays on
        this machine.
      </p>
      <div className="empty-actions">
        <button type="button" className="button primary" onClick={onNew}>
          <Plus size={15} /> New review
        </button>
        <button type="button" className="button secondary" disabled={demoBusy} onClick={onDemo}>
          {demoBusy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{' '}
          {demoBusy ? 'Starting…' : 'Try demo'}
        </button>
      </div>
      <p className="fine-print">The demo is scripted and local. It never calls a paid model.</p>
    </div>
  );
}

function App() {
  const [station, setStation] = useState<StationState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [view, setView] = useState<View>('workspace');
  const [runTab, setRunTab] = useState<RunTab>('findings');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewRepoId, setReviewRepoId] = useState<string | undefined>(undefined);
  const [showRepoForm, setShowRepoForm] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [sseStatus, setSseStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [actionBusy, setActionBusy] = useState<'demo' | 'run-action' | 'adjust' | 'draft' | null>(
    null,
  );
  const selectedRunRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const sseTimerRef = useRef<number | undefined>(undefined);
  const sseLastRefreshRef = useRef(0);
  selectedRunRef.current = selectedRunId;

  const loadState = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await api<StationState>('/state');
      setStation(next);
      setStateError(null);
      setSelectedRunId((current) =>
        current && next.runs.some((run) => run.id === current)
          ? current
          : (next.runs[0]?.id ?? null),
      );
    } catch (error) {
      setStateError(error instanceof Error ? error.message : 'Could not connect to the station');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (runId: string, quiet = false) => {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    const requestId = ++detailRequestRef.current;
    if (!quiet) setDetailLoading(true);
    try {
      const next = await api<RunDetail>(`/runs/${encodeURIComponent(runId)}`, {
        signal: controller.signal,
      });
      if (requestId === detailRequestRef.current && selectedRunRef.current === runId)
        setDetail(next);
    } catch (error) {
      if (controller.signal.aborted) return;
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not load run details',
      });
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (selectedRunId) void loadDetail(selectedRunId);
    else setDetail(null);
  }, [selectedRunId, loadDetail]);

  useEffect(() => {
    let source: EventSource | undefined;
    try {
      source = new EventSource('/api/events');
      source.onopen = () => setSseStatus('connected');
      source.onerror = () => setSseStatus('offline');
      source.addEventListener('station', () => {
        const now = Date.now();
        const wait = Math.max(0, 500 - (now - sseLastRefreshRef.current));
        window.clearTimeout(sseTimerRef.current);
        sseTimerRef.current = window.setTimeout(() => {
          sseLastRefreshRef.current = Date.now();
          void loadState(true);
          const runId = selectedRunRef.current;
          if (runId) void loadDetail(runId, true);
        }, wait);
      });
    } catch {
      setSseStatus('offline');
    }
    return () => {
      window.clearTimeout(sseTimerRef.current);
      source?.close();
    };
  }, [loadDetail, loadState]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!mobileNav) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNav(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNav]);

  const selectedRun = useMemo(() => {
    if (!station || !selectedRunId) return detail?.run ?? null;
    return station.runs.find((run) => run.id === selectedRunId) ?? detail?.run ?? null;
  }, [detail?.run, selectedRunId, station]);

  const runAction = async (action: 'cancel' | 'retry') => {
    if (!selectedRunId || actionBusy) return;
    setActionBusy('run-action');
    try {
      const next = await api<Run>(`/runs/${selectedRunId}/${action}`, {
        method: 'POST',
        body: '{}',
      });
      setSelectedRunId(next.id);
      await loadState(true);
      await loadDetail(next.id);
      setNotice({ kind: 'success', text: action === 'cancel' ? 'Run cancelled' : 'Retry queued' });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Action failed' });
    } finally {
      setActionBusy(null);
    }
  };

  const tryDemo = async () => {
    if (actionBusy) return;
    setActionBusy('demo');
    try {
      const result = await api<{ repo: RepositoryRecord; run: Run }>('/demo', {
        method: 'POST',
        body: '{}',
      });
      await loadState(true);
      setView('workspace');
      setSelectedRunId(result.run.id);
      setShowReviewForm(false);
      setNotice({ kind: 'success', text: 'Scripted demo started' });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not start demo',
      });
    } finally {
      setActionBusy(null);
    }
  };

  const startAdjustedReview = async (request: ReviewRequest) => {
    if (actionBusy) return;
    setActionBusy('adjust');
    try {
      const run = await api<Run>('/runs', { method: 'POST', body: JSON.stringify(request) });
      setSelectedRunId(run.id);
      await loadState(true);
      await loadDetail(run.id);
      setNotice({ kind: 'success', text: 'Adjusted review queued' });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not queue adjusted review',
      });
    } finally {
      setActionBusy(null);
    }
  };

  const draftPack = async (findingId: string) => {
    if (!selectedRunId || actionBusy) return;
    setActionBusy('draft');
    try {
      await api<JudgmentPack>(`/runs/${encodeURIComponent(selectedRunId)}/pack-draft`, {
        method: 'POST',
        body: JSON.stringify({ findingId }),
      });
      await loadState(true);
      setView('packs');
      setNotice({ kind: 'success', text: 'Draft judgment pack saved inactive' });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not draft judgment rule',
      });
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          type="button"
          className="mobile-menu button icon-button"
          aria-label="Open navigation"
          aria-expanded={mobileNav}
          aria-controls="station-rail"
          onClick={() => setMobileNav(true)}
        >
          <Menu size={18} />
        </button>
        <div className="brand">
          <span className="brand-glyph" aria-hidden="true">
            <Code2 size={13} />
          </span>
          <span>Station</span>
        </div>
        <div className="topbar-spacer" />
        <div className="heading-actions toolbar-actions">
          <button type="button" className="button secondary" onClick={() => void loadState()}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              setReviewRepoId(undefined);
              setShowReviewForm(true);
            }}
          >
            <Plus size={15} /> New review
          </button>
        </div>
        <div
          className={`connection ${stateError || sseStatus === 'offline' ? 'offline' : sseStatus === 'connecting' ? 'connecting' : 'online'}`}
        >
          <span className="connection-dot" />
          {stateError || sseStatus === 'offline'
            ? 'Offline'
            : sseStatus === 'connecting'
              ? 'Connecting'
              : 'Connected'}
        </div>
        <div className="worker-state">
          <span className="worker-dot" /> {station?.settings.maxWorkers ?? '—'} workers
        </div>
      </header>

      <div className="app-body">
        {mobileNav && (
          <button
            type="button"
            className="rail-scrim"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          />
        )}
        <aside id="station-rail" className={`rail ${mobileNav ? 'mobile-open' : ''}`}>
          <div className="mobile-rail-head">
            <span className="eyebrow">Navigate</span>
            <button
              type="button"
              className="button icon-button"
              onClick={() => setMobileNav(false)}
              aria-label="Close navigation"
            >
              <X size={17} />
            </button>
          </div>
          <nav className="primary-nav" aria-label="Primary navigation">
            <button
              type="button"
              className={`nav-item ${view === 'workspace' ? 'active' : ''}`}
              aria-current={view === 'workspace' ? 'page' : undefined}
              onClick={() => {
                setView('workspace');
                setMobileNav(false);
              }}
            >
              <PanelLeft size={16} /> Reviews{' '}
              <span className="nav-count">{station?.runs.length ?? 0}</span>
            </button>
            <button
              type="button"
              className={`nav-item ${view === 'repositories' ? 'active' : ''}`}
              aria-current={view === 'repositories' ? 'page' : undefined}
              onClick={() => {
                setView('repositories');
                setMobileNav(false);
              }}
            >
              <FolderGit2 size={16} /> Repositories
            </button>
            <button
              type="button"
              className={`nav-item ${view === 'packs' ? 'active' : ''}`}
              aria-current={view === 'packs' ? 'page' : undefined}
              onClick={() => {
                setView('packs');
                setMobileNav(false);
              }}
            >
              <Layers3 size={16} /> Packs{' '}
              <span className="nav-count">{station?.packs.length ?? 0}</span>
            </button>
          </nav>

          <div className="rail-section-head">
            <span>Repositories</span>
            <button
              type="button"
              className="button icon-button tiny"
              aria-label="Register repository"
              onClick={() => setShowRepoForm(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="repo-list">
            {station?.repos.length ? (
              station.repos.map((repo) => (
                <button
                  type="button"
                  className="repo-item"
                  key={repo.id}
                  onClick={() => {
                    setView('workspace');
                    setReviewRepoId(repo.id);
                    setShowReviewForm(true);
                  }}
                >
                  <span className="repo-icon">
                    <GitBranch size={14} />
                  </span>
                  <span className="truncate">
                    <strong>{repo.name}</strong>
                    <small>{repo.path}</small>
                  </span>
                </button>
              ))
            ) : (
              <p className="rail-empty">No repositories yet.</p>
            )}
          </div>
          <div className="rail-footer">
            <span className="tiny-logo">◎</span>
            <span>On this Mac</span>
          </div>
        </aside>

        <main className="main-area">
          {notice && (
            <div className={`notice ${notice.kind}`} role="status">
              {notice.kind === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
              {notice.text}
              <button onClick={() => setNotice(null)} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          )}
          {stateError && (
            <div className="error-banner">
              <AlertCircle size={17} />
              <span>
                <strong>Station unavailable.</strong> {stateError}
              </span>
              <button className="button secondary compact" onClick={() => void loadState()}>
                Retry connection
              </button>
            </div>
          )}
          {view === 'repositories' && station && (
            <RepositoriesView
              repos={station.repos}
              onRegister={() => setShowRepoForm(true)}
              onReview={(repoId) => {
                setReviewRepoId(repoId);
                setShowReviewForm(true);
              }}
            />
          )}
          {view === 'packs' && station && (
            <PacksView
              packs={station.packs}
              onRefresh={() => void loadState(true)}
              setNotice={setNotice}
            />
          )}
          {view === 'workspace' && (
            <WorkspaceView
              station={station}
              loading={loading}
              selectedRun={selectedRun}
              detail={detail}
              detailLoading={detailLoading}
              tab={runTab}
              setTab={setRunTab}
              onSelect={(id) => setSelectedRunId(id)}
              onNew={() => {
                setReviewRepoId(undefined);
                setShowReviewForm(true);
              }}
              onDemo={() => void tryDemo()}
              actionBusy={actionBusy}
              onAction={runAction}
              setNotice={setNotice}
              onAdjusted={startAdjustedReview}
              onDraftPack={draftPack}
              onFeedbackSaved={() =>
                selectedRunId ? loadDetail(selectedRunId, true) : Promise.resolve()
              }
            />
          )}
        </main>
      </div>

      {showRepoForm && (
        <RepoModal
          onClose={() => setShowRepoForm(false)}
          onSaved={async () => {
            setShowRepoForm(false);
            await loadState(true);
          }}
          setNotice={setNotice}
        />
      )}
      {showReviewForm && (
        <ReviewModal
          station={station}
          initialRepoId={reviewRepoId}
          onClose={() => setShowReviewForm(false)}
          onCreated={async (run) => {
            setShowReviewForm(false);
            setReviewRepoId(undefined);
            setView('workspace');
            setSelectedRunId(run.id);
            await loadState(true);
            await loadDetail(run.id);
          }}
          setNotice={setNotice}
        />
      )}
    </div>
  );
}

function WorkspaceView({
  station,
  loading,
  selectedRun,
  detail,
  detailLoading,
  tab,
  setTab,
  onSelect,
  onNew,
  onDemo,
  actionBusy,
  onAction,
  setNotice,
  onAdjusted,
  onDraftPack,
  onFeedbackSaved,
}: {
  station: StationState | null;
  loading: boolean;
  selectedRun: Run | null;
  detail: RunDetail | null;
  detailLoading: boolean;
  tab: RunTab;
  setTab: (tab: RunTab) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDemo: () => void;
  actionBusy: 'demo' | 'run-action' | 'adjust' | 'draft' | null;
  onAction: (action: 'cancel' | 'retry') => void;
  setNotice: (notice: Notice) => void;
  onAdjusted: (request: ReviewRequest) => Promise<void>;
  onDraftPack: (findingId: string) => Promise<void>;
  onFeedbackSaved: () => Promise<void>;
}) {
  return (
    <div className="workspace-view">
      {loading && !station ? (
        <LoadingState />
      ) : station?.runs.length ? (
        <div className="master-detail">
          <section className="run-column" aria-label="Review runs">
            <div className="list-toolbar">
              <span className="section-label">
                All runs <span className="count-chip">{station.runs.length}</span>
              </span>
            </div>
            <div className="run-list">
              {station.runs.map((run) => (
                <RunListItem
                  key={run.id}
                  run={run}
                  selected={run.id === selectedRun?.id}
                  onClick={() => onSelect(run.id)}
                />
              ))}
            </div>
          </section>
          <section className="detail-column">
            {selectedRun && detail ? (
              <RunWorkspace
                key={selectedRun.id}
                run={selectedRun}
                detail={detail}
                detailLoading={detailLoading}
                tab={tab}
                setTab={setTab}
                onAction={onAction}
                actionBusy={actionBusy}
                setNotice={setNotice}
                onAdjusted={onAdjusted}
                onDraftPack={onDraftPack}
                onFeedbackSaved={onFeedbackSaved}
              />
            ) : (
              <div className="detail-placeholder">
                <div className="empty-mark small">
                  <ArrowLeft size={18} />
                </div>
                <p>Select a run to inspect its plan and findings.</p>
              </div>
            )}
          </section>
        </div>
      ) : (
        <EmptyState onDemo={onDemo} onNew={onNew} demoBusy={actionBusy === 'demo'} />
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-state" aria-busy="true" aria-label="Connecting to local station">
      <div className="skeleton-split">
        <div className="skeleton-col">
          {Array.from({ length: 6 }, (_, index) => (
            <div className="skeleton-row" key={index} />
          ))}
        </div>
        <div className="skeleton-detail">
          <div className="skeleton-line wide" />
          <div className="skeleton-line" />
          <div className="skeleton-line short" />
        </div>
      </div>
    </div>
  );
}

function RunListItem({
  run,
  selected,
  onClick,
}: {
  run: Run;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`run-item ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className="run-item-top">
        <span className="run-title truncate">
          {run.title || run.request.task || 'Untitled review'}
        </span>
        <span className="run-time">{timeAgo(run.updatedAt)}</span>
      </div>
      <div className="run-item-meta">
        <span className="repo-name">
          <GitBranch size={12} /> {run.repoName}
        </span>
        <StatusPill status={run.status} />
      </div>
      <div className="run-item-bottom">
        <span title={`${run.request.base} → ${run.request.head}`}>
          {displayRef(run.request.base)} <ChevronRight size={11} /> {displayRef(run.request.head)}
        </span>
        <span>
          {run.findings.length
            ? `${run.findings.length} finding${run.findings.length === 1 ? '' : 's'}`
            : 'No findings'}
        </span>
      </div>
    </button>
  );
}

function RunWorkspace({
  run,
  detail,
  detailLoading,
  tab,
  setTab,
  onAction,
  actionBusy,
  setNotice,
  onAdjusted,
  onDraftPack,
  onFeedbackSaved,
}: {
  run: Run;
  detail: RunDetail;
  detailLoading: boolean;
  tab: RunTab;
  setTab: (tab: RunTab) => void;
  onAction: (action: 'cancel' | 'retry') => void;
  actionBusy: 'demo' | 'run-action' | 'adjust' | 'draft' | null;
  setNotice: (notice: Notice) => void;
  onAdjusted: (request: ReviewRequest) => Promise<void>;
  onDraftPack: (findingId: string) => Promise<void>;
  onFeedbackSaved: () => Promise<void>;
}) {
  const canCancel = run.status === 'queued' || run.status === 'running';
  const canRetry =
    run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted';
  const context = detail.context;
  return (
    <div className="run-workspace">
      <div className="run-heading">
        <div className="run-heading-main">
          <div className="back-label">
            <span className="live-mark" /> Review
          </div>
          <h2>{run.title || run.request.task || 'Untitled review'}</h2>
          <div className="run-subline">
            <span>
              <FolderGit2 size={14} /> {run.repoName}
            </span>
            <span className="divider-dot">·</span>
            <span title={`${run.request.base} → ${run.request.head}`}>
              <GitBranch size={14} /> {displayRef(run.request.base)} <ChevronRight size={11} />{' '}
              {displayRef(run.request.head)}
            </span>
            <span className="divider-dot">·</span>
            <span>{formatDate(run.createdAt)}</span>
          </div>
        </div>
        <div className="run-actions">
          <StatusPill status={run.status} />
          {canCancel && (
            <button
              className="button secondary compact"
              disabled={Boolean(actionBusy)}
              onClick={() => onAction('cancel')}
            >
              {actionBusy === 'run-action' ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Pause size={14} />
              )}{' '}
              {actionBusy === 'run-action' ? 'Working…' : 'Cancel'}
            </button>
          )}
          {canRetry && (
            <button
              className="button secondary compact"
              disabled={Boolean(actionBusy)}
              onClick={() => onAction('retry')}
            >
              {actionBusy === 'run-action' ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <RefreshCw size={14} />
              )}{' '}
              {actionBusy === 'run-action' ? 'Working…' : 'Retry'}
            </button>
          )}
          <a
            className="button secondary compact"
            href={`/api/runs/${encodeURIComponent(run.id)}/export?format=markdown`}
            download
          >
            <ArrowDownToLine size={14} /> MD
          </a>
          <a
            className="button secondary compact"
            href={`/api/runs/${encodeURIComponent(run.id)}/export?format=json`}
            download
          >
            <ArrowDownToLine size={14} /> JSON
          </a>
        </div>
      </div>
      <PlanStrip run={run} />
      <div className="tab-bar" role="tablist" aria-label="Run detail">
        <TabButton
          tab="findings"
          current={tab}
          icon={<ShieldCheck size={15} />}
          label="Findings"
          count={run.findings.length}
          onClick={setTab}
        />
        <TabButton
          tab="context"
          current={tab}
          icon={<Database size={15} />}
          label="Context"
          count={context?.manifest.items.length}
          onClick={setTab}
        />
        <TabButton
          tab="activity"
          current={tab}
          icon={<Activity size={15} />}
          label="Activity"
          count={detail.events.length}
          onClick={setTab}
        />
        <TabButton
          tab="packs"
          current={tab}
          icon={<Layers3 size={15} />}
          label="Packs"
          count={context?.manifest.packs.length}
          onClick={setTab}
        />
      </div>
      <div className="detail-scroll">
        {detailLoading && (
          <div className="detail-loading">
            <LoaderCircle size={15} className="spin" /> Updating run…
          </div>
        )}
        {(run.status === 'needs_input' || context?.status === 'needs_input') && (
          <ContextAdjustForm run={run} disabled={actionBusy !== null} onSubmit={onAdjusted} />
        )}
        {tab === 'findings' && (
          <FindingsTab
            run={run}
            detail={detail}
            setNotice={setNotice}
            onDraftPack={onDraftPack}
            onFeedbackSaved={onFeedbackSaved}
          />
        )}
        {tab === 'context' && <ContextTab context={context} />}
        {tab === 'activity' && <ActivityTab events={detail.events} context={context} />}
        {tab === 'packs' && (
          <RunPacksTab packs={context?.manifest.packs ?? []} snapshot={run.packSnapshot ?? []} />
        )}
      </div>
      <RunMeta run={run} context={context} />
    </div>
  );
}

function TabButton({
  tab,
  current,
  icon,
  label,
  count,
  onClick,
}: {
  tab: RunTab;
  current: RunTab;
  icon: React.ReactNode;
  label: string;
  count?: number;
  onClick: (tab: RunTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tab === current}
      className={`tab ${tab === current ? 'active' : ''}`}
      onClick={() => onClick(tab)}
    >
      {icon}
      {label}
      {typeof count === 'number' && <span className="tab-count">{count}</span>}
    </button>
  );
}

function PlanStrip({ run }: { run: Run }) {
  return (
    <div className="plan-strip">
      <div className="strip-title">Plan</div>
      {run.nodes.map((node, index) => (
        <div
          className={`plan-node ${node.status === 'skipped' ? 'skipped' : STATUS_TONES[node.status]}`}
          key={`${node.name}-${index}`}
        >
          <div className="plan-node-line">
            <span className="plan-number">
              {node.status === 'completed' ? <Check size={12} /> : index + 1}
            </span>
            <span>{node.name}</span>
          </div>
          <small>{node.status === 'skipped' ? 'Skipped' : STATUS_LABELS[node.status]}</small>
          {index < run.nodes.length - 1 && <span className="plan-connector" />}
        </div>
      ))}
    </div>
  );
}

function FindingsTab({
  run,
  detail,
  setNotice,
  onDraftPack,
  onFeedbackSaved,
}: {
  run: Run;
  detail: RunDetail;
  setNotice: (notice: Notice) => void;
  onDraftPack: (findingId: string) => Promise<void>;
  onFeedbackSaved: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<'all' | Finding['disposition']>('all');
  const findings = run.findings.filter(
    (finding) => filter === 'all' || finding.disposition === filter,
  );
  const feedbackFor = (id: string) =>
    detail.feedback.filter((feedback) => feedback.findingId === id).at(-1);
  return (
    <div className="findings-tab">
      <div className="tab-intro">
        <div>
          <h3>
            {run.findings.length
              ? `${run.findings.length} finding${run.findings.length === 1 ? '' : 's'}`
              : 'No findings yet'}
          </h3>
        </div>
        <div className="filter-group" aria-label="Filter findings">
          {(['all', 'pending', 'supported', 'uncertain', 'rejected'] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={filter === value ? 'active' : ''}
              onClick={() => setFilter(value)}
            >
              {labelize(value)}
            </button>
          ))}
        </div>
      </div>
      {run.error && (
        <div className="partial-banner">
          <AlertCircle size={16} />
          <div>
            <strong>This review is incomplete.</strong>
            <span>{run.error}</span>
          </div>
        </div>
      )}
      {findings.length ? (
        <div className="finding-list">
          {findings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              feedback={feedbackFor(finding.id)}
              onDraftPack={onDraftPack}
              onFeedback={async (payload) => {
                try {
                  await api<Feedback>(`/runs/${run.id}/feedback`, {
                    method: 'POST',
                    body: JSON.stringify({ findingId: finding.id, ...payload }),
                  });
                  await onFeedbackSaved();
                  setNotice({ kind: 'success', text: 'Feedback recorded' });
                } catch (error) {
                  setNotice({
                    kind: 'error',
                    text: error instanceof Error ? error.message : 'Could not record feedback',
                  });
                }
              }}
            />
          ))}
        </div>
      ) : (
        <div className="sub-empty">
          <CircleDot size={18} />
          <span>
            {run.findings.length
              ? 'No findings match this filter.'
              : run.status === 'running' || run.status === 'queued'
                ? 'Findings will appear as the review runs.'
                : 'The reviewer did not return any findings.'}
          </span>
        </div>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  feedback,
  onFeedback,
  onDraftPack,
}: {
  finding: Finding;
  feedback?: Feedback;
  onFeedback: (payload: { verdict: Feedback['verdict']; note: string }) => Promise<void>;
  onDraftPack: (findingId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(feedback?.note ?? '');
  const [verdict, setVerdict] = useState<Feedback['verdict']>(feedback?.verdict ?? 'useful');
  const [saving, setSaving] = useState(false);
  return (
    <article className={`finding-card severity-${finding.severity}`}>
      <div className="finding-main">
        <div className="finding-header">
          <span className={`severity-dot ${finding.severity}`} />{' '}
          <span className="severity-label">{finding.severity}</span>
          <span className={`disposition ${finding.disposition}`}>{finding.disposition}</span>
          <span className="finding-id">{finding.id}</span>
        </div>
        <h4>{finding.title}</h4>
        <p>{finding.body}</p>
        <div className="finding-location">
          <FileCode2 size={14} />
          <code>{finding.path}</code>
          <span>
            lines {finding.startLine}–{finding.endLine}
          </span>
          {finding.side === 'base' && <span className="side-label">base</span>}
        </div>
        {finding.evidence.length > 0 && (
          <div className="evidence">
            <MessageSquareText size={14} />
            <span>
              Supported by {finding.evidence.length} context excerpt
              {finding.evidence.length === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </div>
      <div className="finding-footer">
        <button
          className="text-button"
          disabled={saving}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide feedback' : feedback ? 'Edit feedback' : 'Give feedback'}{' '}
          <ChevronRight size={14} className={open ? 'rotate-90' : ''} />
        </button>
        {feedback && (
          <span className="feedback-saved">
            <Check size={13} /> {feedback.verdict}
          </span>
        )}
        {feedback?.note.trim() && (
          <button
            className="text-button draft-pack-button"
            disabled={saving}
            onClick={() => void onDraftPack(finding.id)}
          >
            <Plus size={13} /> Draft judgment rule
          </button>
        )}
      </div>
      {open && (
        <form
          className="feedback-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving) return;
            setSaving(true);
            try {
              await onFeedback({ verdict, note });
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="feedback-options">
            {(['useful', 'incorrect', 'unclear'] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={verdict === value ? 'selected' : ''}
                onClick={() => setVerdict(value)}
                disabled={saving}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="feedback-row">
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Optional note for the next review"
              aria-label="Feedback note"
              disabled={saving}
            />
            <button className="button primary compact" type="submit" disabled={saving}>
              {saving ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />}{' '}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

function ContextTab({ context }: { context: ContextPacket | null }) {
  const [selected, setSelected] = useState<ContextItem | null>(null);
  if (!context)
    return (
      <div className="sub-empty">
        <Database size={18} />
        <span>Context is not available for this run yet.</span>
      </div>
    );
  return (
    <div className="context-tab">
      <div className="context-summary">
        <div>
          <p className="eyebrow">Manifest v{context.manifest.version}</p>
          <h3>{context.manifest.items.length} excerpts</h3>
          <p className="muted">
            Compiler {context.manifest.compilerVersion} · {formatBytes(context.byteLength)} · ~
            {context.estimatedTokens.toLocaleString()} tokens
          </p>
        </div>
        <div className="context-stats">
          <span>
            <strong>{context.symbols.length}</strong> symbols
          </span>
          <span>
            <strong>{context.manifest.omitted.length}</strong> omitted
          </span>
        </div>
      </div>
      <div className="policy-strip">
        <span>
          <strong>{formatBytes(context.manifest.policy.maxBytes)}</strong> context budget
        </span>
        <span>
          <strong>{formatBytes(context.manifest.policy.maxPackBytes)}</strong> pack budget
        </span>
        <span>
          <strong>{context.manifest.policy.maxToolCalls}</strong> tool calls
        </span>
        <span>
          <strong>{Math.round(context.manifest.policy.timeoutMs / 1000)}s</strong> timeout
        </span>
      </div>
      {context.manifest.limitations.length > 0 && (
        <div className="limitation-line">
          <Info size={15} />
          <span>{context.manifest.limitations.join(' ')}</span>
        </div>
      )}
      <div className="context-table">
        <div className="context-table-head">
          <span>File</span>
          <span>Lines</span>
          <span>Reason</span>
          <span />
        </div>
        {context.manifest.items.map((item) => (
          <div className="context-row" key={item.id}>
            <div className="context-file">
              <FileCode2 size={15} />
              <span>
                <strong>{item.path}</strong>
                <small>
                  {item.side} · {item.symbol ?? 'whole file'}
                </small>
              </span>
            </div>
            <span>
              {item.startLine}–{item.endLine}
            </span>
            <span className="reason-truncate">{item.reason}</span>
            <button
              type="button"
              className="text-button why-button"
              onClick={() => setSelected(item)}
            >
              Why this file? <ChevronRight size={13} />
            </button>
          </div>
        ))}
      </div>
      {selected && <ContextDrawer item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ContextDrawer({ item, onClose }: { item: ContextItem; onClose: () => void }) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="context-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <p className="eyebrow">Why this file</p>
            <h3>{item.path}</h3>
          </div>
          <button
            type="button"
            className="button icon-button"
            onClick={onClose}
            aria-label="Close context details"
          >
            <X size={17} />
          </button>
        </div>
        <div className="drawer-section">
          <span className="detail-label">Why this file?</span>
          <p>{item.reason}</p>
          {item.via && (
            <p className="via-line">
              <GitBranch size={14} /> via {item.via}
            </p>
          )}
        </div>
        <div className="drawer-section">
          <span className="detail-label">Selected excerpt</span>
          <pre>{item.content}</pre>
        </div>
      </aside>
    </div>
  );
}

function ActivityTab({ events, context }: { events: RunEvent[]; context: ContextPacket | null }) {
  const [selected, setSelected] = useState<ContextItem | null>(null);
  return events.length ? (
    <div className="activity-list">
      {events.map((event) => {
        const itemId = typeof event.data.itemId === 'string' ? event.data.itemId : null;
        const item = itemId
          ? context?.manifest.items.find((candidate) => candidate.id === itemId)
          : undefined;
        return (
          <div className="activity-event" key={event.id}>
            <div className="activity-icon">
              <Activity size={14} />
            </div>
            <div className="activity-content">
              <div>
                <strong>{event.type}</strong>
                <span>{formatDate(event.time)}</span>
              </div>
              <pre>{JSON.stringify(event.data, null, 2)}</pre>
              {item && (
                <button
                  className="text-button activity-context-link"
                  onClick={() => setSelected(item)}
                >
                  Open captured excerpt <ChevronRight size={13} />
                </button>
              )}
            </div>
          </div>
        );
      })}
      {selected && <ContextDrawer item={selected} onClose={() => setSelected(null)} />}
    </div>
  ) : (
    <div className="sub-empty">
      <Activity size={18} />
      <span>No durable station events for this run yet.</span>
    </div>
  );
}

function RunPacksTab({
  packs,
  snapshot,
}: {
  packs: { id: string; version: number }[];
  snapshot: JudgmentPack[];
}) {
  return packs.length ? (
    <div className="run-packs-list">
      {packs.map((pack) => {
        const saved = snapshot.find(
          (candidate) => candidate.id === pack.id && candidate.version === pack.version,
        );
        return (
          <div key={`${pack.id}-${pack.version}`} className="run-pack-row">
            <PackageCheck size={16} />
            <span>
              <code>{saved?.name ?? pack.id}</code>
              {saved && <small>{saved.rules.length} saved rules</small>}
            </span>
            <span>v{pack.version}</span>
            <span className="muted">Immutable snapshot used by this run</span>
          </div>
        );
      })}
    </div>
  ) : (
    <div className="sub-empty">
      <Layers3 size={18} />
      <span>No judgment packs were attached to this run.</span>
    </div>
  );
}

function ContextAdjustForm({
  run,
  disabled,
  onSubmit,
}: {
  run: Run;
  disabled: boolean;
  onSubmit: (request: ReviewRequest) => Promise<void>;
}) {
  const [scope, setScope] = useState((run.request.scopePaths ?? []).join(', '));
  const [maxBytesKiB, setMaxBytesKiB] = useState(
    String(Math.max(96, Math.round((run.request.policy?.maxBytes ?? 96 * 1024) / 1024))),
  );
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSubmit({
        ...run.request,
        scopePaths: scope
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        policy: {
          ...run.request.policy,
          maxBytes: Math.max(256, Math.round(Number(maxBytesKiB) * 1024)),
        },
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="needs-input-panel" onSubmit={submit}>
      <div className="needs-input-copy">
        <div className="eyebrow">Needs a narrower pass</div>
        <strong>Narrow the scope or raise the context budget</strong>
        <span>
          The first pass could not fit the required context. This starts a new run with the same
          refs and task.
        </span>
      </div>
      <div className="needs-input-fields">
        <label>
          Scope paths
          <input
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            placeholder="src/payments, test/payments"
            disabled={disabled || saving}
          />
        </label>
        <label>
          Context budget (KiB)
          <input
            type="number"
            min="1"
            value={maxBytesKiB}
            onChange={(event) => setMaxBytesKiB(event.target.value)}
            disabled={disabled || saving}
          />
        </label>
        <button className="button primary compact" type="submit" disabled={disabled || saving}>
          {saving ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          {saving ? 'Starting…' : 'Start adjusted review'}
        </button>
      </div>
    </form>
  );
}

function RunMeta({ run, context }: { run: Run; context: ContextPacket | null }) {
  return (
    <div className="run-meta">
      <div className="meta-item">
        <span>Runtime</span>
        <strong>{run.request.runtime === 'pi' ? 'Pi worker' : 'Scripted demo'}</strong>
      </div>
      <div className="meta-item">
        <span>Model</span>
        <strong>{run.model || run.request.model || 'Not reported'}</strong>
      </div>
      <div className="meta-item">
        <span>Tool calls</span>
        <strong>{run.usage.toolCalls}</strong>
      </div>
      <div className="meta-item">
        <span>Read bytes</span>
        <strong>{formatBytes(run.usage.readBytes)}</strong>
      </div>
      <div className="meta-item">
        <span>Cost</span>
        <strong>{run.usage.cost == null ? 'Unavailable' : `$${run.usage.cost.toFixed(4)}`}</strong>
      </div>
      {context?.status === 'needs_input' && (
        <div className="meta-warning">
          <Info size={14} /> Context needs input
        </div>
      )}
    </div>
  );
}

function RepositoriesView({
  repos,
  onRegister,
  onReview,
}: {
  repos: RepositoryRecord[];
  onRegister: () => void;
  onReview: (repoId: string) => void;
}) {
  return (
    <div className="simple-page">
      <div className="page-heading">
        <div>
          <h1>Repositories</h1>
        </div>
        <div className="heading-actions">
          <button type="button" className="button primary" onClick={onRegister}>
            <Plus size={15} /> Register repository
          </button>
        </div>
      </div>
      <div className="repo-page-grid">
        {repos.length ? (
          repos.map((repo) => (
            <article className="repo-card" key={repo.id}>
              <div className="repo-card-top">
                <span className="repo-icon large">
                  <FolderGit2 size={18} />
                </span>
              </div>
              <h3>{repo.name}</h3>
              <p className="mono muted path-line">{repo.path}</p>
              <div className="repo-card-bottom">
                <span>Registered {formatDate(repo.createdAt)}</span>
                <button className="text-button" onClick={() => onReview(repo.id)}>
                  Review changes <ArrowDownToLine size={13} />
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="panel-empty">
            <FolderGit2 size={22} />
            <h3>No repositories registered</h3>
            <p className="muted">Add a local checkout before creating a review.</p>
            <button className="button secondary" onClick={onRegister}>
              <Plus size={15} /> Register path
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PacksView({
  packs,
  onRefresh,
  setNotice,
}: {
  packs: JudgmentPack[];
  onRefresh: () => void;
  setNotice: (notice: Notice) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<JudgmentPack | null>(null);
  const save = async (pack: JudgmentPack) => {
    try {
      await api<JudgmentPack>('/packs', { method: 'POST', body: JSON.stringify(pack) });
      setShowForm(false);
      setEditing(null);
      onRefresh();
      setNotice({ kind: 'success', text: `Saved ${pack.name} v${pack.version}` });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not save pack',
      });
    }
  };
  const openNew = () => {
    setEditing(null);
    setShowForm(true);
  };
  const openEdit = (pack: JudgmentPack) => {
    setEditing(pack);
    setShowForm(true);
  };
  return (
    <div className="simple-page">
      <div className="page-heading">
        <div>
          <h1>Judgment packs</h1>
        </div>
        <div className="heading-actions">
          <button type="button" className="button primary" onClick={openNew}>
            <Plus size={15} /> New version
          </button>
        </div>
      </div>
      {showForm && (
        <PackForm
          initial={editing ? { ...editing, version: editing.version + 1 } : undefined}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSave={save}
        />
      )}
      {packs.length ? (
        <div className="pack-list">
          {packs.map((pack) => (
            <PackCard
              key={`${pack.id}-${pack.version}`}
              pack={pack}
              onEdit={() => openEdit(pack)}
              onToggle={() => save({ ...pack, version: pack.version + 1, active: !pack.active })}
            />
          ))}
        </div>
      ) : (
        <div className="panel-empty">
          <Layers3 size={22} />
          <h3>No judgment packs yet</h3>
          <p className="muted">Create a pack to give reviewers durable, explicit rules.</p>
          <button className="button secondary" onClick={openNew}>
            <Plus size={15} /> Create pack
          </button>
        </div>
      )}
    </div>
  );
}

function PackCard({
  pack,
  onToggle,
  onEdit,
}: {
  pack: JudgmentPack;
  onToggle: () => void;
  onEdit: () => void;
}) {
  return (
    <article className="pack-card">
      <div className="pack-card-head">
        <div>
          <div className="pack-title-row">
            <h3>{pack.name}</h3>
            <span className="version-tag">v{pack.version}</span>
          </div>
          <p className="mono muted">{pack.id}</p>
        </div>
        <div className="pack-card-actions">
          <button type="button" className="button secondary compact" onClick={onEdit}>
            <FileCode2 size={13} /> Edit v{pack.version + 1}
          </button>
          <button
            type="button"
            className={`toggle ${pack.active ? 'on' : ''}`}
            onClick={onToggle}
            aria-label={`${pack.active ? 'Deactivate' : 'Activate'} ${pack.name}`}
            aria-pressed={pack.active}
          >
            <span />
          </button>
        </div>
      </div>
      <div className="pack-meta">
        <span>{pack.rules.length} rules</span>
        <span>{pack.roles.join(' · ')}</span>
        <span>{pack.globs.length ? pack.globs.join(', ') : 'All files'}</span>
        <strong className={pack.active ? 'active-text' : 'muted'}>
          {pack.active ? 'Active' : 'Inactive'}
        </strong>
      </div>
      {pack.rules.length > 0 && (
        <div className="pack-rule-preview">
          <span>{pack.rules[0].text}</span>
        </div>
      )}
    </article>
  );
}

function PackForm({
  initial,
  onCancel,
  onSave,
}: {
  initial?: JudgmentPack;
  onCancel: () => void;
  onSave: (pack: JudgmentPack) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [id, setId] = useState(initial?.id ?? '');
  const [glob, setGlob] = useState(initial?.globs.join(', ') ?? '**/*');
  const [roles, setRoles] = useState(initial?.roles.join(', ') ?? 'reviewer');
  const [rules, setRules] = useState(JSON.stringify(initial?.rules ?? [], null, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    try {
      const parsed = JSON.parse(rules) as JudgmentPack['rules'];
      if (!Array.isArray(parsed) || parsed.length === 0)
        throw new Error('Add at least one rule in valid JSON.');
      setError(null);
      setSaving(true);
      const parsedRoles = roles
        .split(',')
        .map((value) => value.trim())
        .filter(
          (value): value is 'reviewer' | 'verifier' => value === 'reviewer' || value === 'verifier',
        );
      await onSave({
        id: id.trim() || name.trim().toLowerCase().replace(/\s+/g, '-'),
        version: initial?.version ?? 1,
        name: name.trim(),
        active: initial?.active ?? false,
        globs: glob
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        roles: parsedRoles.length ? parsedRoles : ['reviewer'],
        rules: parsed,
      });
    } catch (value) {
      setError(value instanceof Error ? value.message : 'Rules must be valid JSON.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="pack-form" onSubmit={submit}>
      <div className="form-heading">
        <div>
          <p className="eyebrow">Version {initial ? `v${initial.version}` : 'v1'}</p>
          <h3>{initial ? `Edit ${initial.name}` : 'Create a judgment pack'}</h3>
        </div>
        <button type="button" className="button icon-button" onClick={onCancel} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="form-grid">
        <label>
          Name
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Security review"
          />
        </label>
        <label>
          Pack id
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="security-review"
          />
        </label>
        <label>
          File globs
          <input value={glob} onChange={(event) => setGlob(event.target.value)} />
        </label>
        <label>
          Roles
          <input
            value={roles}
            onChange={(event) => setRoles(event.target.value)}
            placeholder="reviewer, verifier"
          />
        </label>
        <label className="pack-rules-field">
          Rules JSON
          <textarea
            required
            rows={8}
            value={rules}
            onChange={(event) => setRules(event.target.value)}
            placeholder={'[{"id":"rule-1","text":"Flag secrets."}]'}
          />
        </label>
      </div>
      {error && (
        <div className="form-error">
          <AlertCircle size={14} /> {error}
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={saving}>
          {saving && <LoaderCircle size={14} className="spin" />}
          {saving ? 'Saving…' : initial ? `Save v${initial.version}` : 'Create v1'}
        </button>
      </div>
    </form>
  );
}

function RepoModal({
  onClose,
  onSaved,
  setNotice,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
  setNotice: (notice: Notice) => void;
}) {
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api<RepositoryRecord>('/repos', {
        method: 'POST',
        body: JSON.stringify({ path: path.trim() }),
      });
      await onSaved();
      setNotice({ kind: 'success', text: 'Repository registered' });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not register repository',
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="Register repository" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted modal-copy">
          Point the station at an existing local Git checkout. It will validate the path without
          changing the working tree.
        </p>
        <label>
          Local path
          <input
            autoFocus
            required
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/me/code/project"
          />
        </label>
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={saving}>
            {saving && <LoaderCircle size={14} className="spin" />}
            {saving ? 'Registering…' : 'Register path'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReviewModal({
  station,
  initialRepoId,
  onClose,
  onCreated,
  setNotice,
}: {
  station: StationState | null;
  initialRepoId?: string;
  onClose: () => void;
  onCreated: (run: Run) => Promise<void>;
  setNotice: (notice: Notice) => void;
}) {
  const [repoId, setRepoId] = useState(initialRepoId ?? station?.repos[0]?.id ?? '');
  const [base, setBase] = useState('main');
  const [head, setHead] = useState('HEAD');
  const [task, setTask] = useState(
    'Review this change for correctness, regressions, and missing tests.',
  );
  const [runtime, setRuntime] = useState<ReviewRequest['runtime']>('pi');
  const [modelKey, setModelKey] = useState(
    station?.models[0] ? modelOptionKey(station.models[0]) : '',
  );
  const [githubUrl, setGithubUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [scope, setScope] = useState('');
  const [maxBytesKiB, setMaxBytesKiB] = useState('96');
  const [saving, setSaving] = useState(false);
  const selectedModel = station?.models.find((item) => modelOptionKey(item) === modelKey);
  const importPullRequest = async () => {
    if (!repoId || !githubUrl.trim() || importing) return;
    setImporting(true);
    try {
      const imported = await api<{ base: string; head: string; title: string }>('/github/import', {
        method: 'POST',
        body: JSON.stringify({ repoId, url: githubUrl.trim() }),
      });
      setBase(imported.base);
      setHead(imported.head);
      if (imported.title) setTask(`Review pull request: ${imported.title}`);
      setNotice({ kind: 'success', text: 'GitHub refs imported' });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not import pull request',
      });
    } finally {
      setImporting(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || (runtime === 'pi' && !selectedModel)) {
      if (runtime === 'pi' && !selectedModel)
        setNotice({
          kind: 'error',
          text: 'Select a configured provider and model for the Pi worker.',
        });
      return;
    }
    setSaving(true);
    try {
      const request: ReviewRequest = {
        repoId,
        base,
        head,
        task,
        runtime,
        provider: selectedModel?.provider,
        model: selectedModel?.id,
        demo: runtime === 'scripted',
      };
      const scopePaths = scope
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (advanced && scopePaths.length) request.scopePaths = scopePaths;
      if (advanced && Number(maxBytesKiB) > 0)
        request.policy = { maxBytes: Math.max(256, Math.round(Number(maxBytesKiB) * 1024)) };
      const run = await api<Run>('/runs', { method: 'POST', body: JSON.stringify(request) });
      await onCreated(run);
      setNotice({ kind: 'success', text: 'Review queued' });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not create review',
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="New review" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="review-form-intro">
          <p className="muted">
            Compare immutable Git contents and give the worker a focused task. Run history and
            captured context remain local.
          </p>
          {station?.modelError && (
            <div className="limitation-line">
              <Info size={15} />
              <span>{station.modelError}</span>
            </div>
          )}
        </div>
        <div className="form-grid two">
          <label>
            Repository
            <select required value={repoId} onChange={(event) => setRepoId(event.target.value)}>
              <option value="" disabled>
                Select a repository
              </option>
              {station?.repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name} — {repo.path}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider + model
            <select
              value={modelKey}
              onChange={(event) => setModelKey(event.target.value)}
              disabled={!station?.models.length}
            >
              <option value="">Not selected</option>
              {station?.models.map((item) => (
                <option key={`${item.provider}-${item.id}`} value={modelOptionKey(item)}>
                  {item.provider} · {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Base ref
            <input
              required
              value={base}
              onChange={(event) => setBase(event.target.value)}
              placeholder="main"
            />
          </label>
          <label>
            Head ref
            <input
              required
              value={head}
              onChange={(event) => setHead(event.target.value)}
              placeholder="HEAD"
            />
          </label>
        </div>
        <div className="github-import">
          <label>
            GitHub PR URL
            <input
              value={githubUrl}
              onChange={(event) => setGithubUrl(event.target.value)}
              placeholder="https://github.com/org/repo/pull/42"
            />
          </label>
          <button
            type="button"
            className="button secondary compact"
            onClick={() => void importPullRequest()}
            disabled={importing || !repoId || !githubUrl.trim()}
          >
            {importing ? <LoaderCircle size={14} className="spin" /> : <GitBranch size={14} />}
            {importing ? 'Importing…' : 'Import refs'}
          </button>
        </div>
        <label>
          Review task
          <textarea
            required
            rows={3}
            value={task}
            onChange={(event) => setTask(event.target.value)}
          />
        </label>
        <div className="runtime-picker">
          <span className="detail-label">Runtime</span>
          <div className="runtime-options">
            <button
              type="button"
              className={runtime === 'pi' ? 'selected' : ''}
              onClick={() => setRuntime('pi')}
            >
              <TerminalSquare size={15} />
              <span>
                <strong>Pi worker</strong>
                <small>Configured provider · sends selected context</small>
              </span>
            </button>
            <button
              type="button"
              className={runtime === 'scripted' ? 'selected' : ''}
              onClick={() => setRuntime('scripted')}
            >
              <Sparkles size={15} />
              <span>
                <strong>Scripted demo</strong>
                <small>Deterministic · no model call</small>
              </span>
            </button>
          </div>
        </div>
        <button
          type="button"
          className="advanced-toggle"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
        >
          {advanced ? 'Hide advanced context' : 'Advanced context'}{' '}
          <ChevronRight size={13} className={advanced ? 'rotate-90' : ''} />
        </button>
        {advanced && (
          <div className="advanced-fields">
            <label>
              Scope paths{' '}
              <input
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                placeholder="src/payments, test/payments"
              />
            </label>
            <label>
              Context budget (KiB)
              <input
                type="number"
                min="1"
                value={maxBytesKiB}
                onChange={(event) => setMaxBytesKiB(event.target.value)}
              />
            </label>
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={saving || !repoId || (runtime === 'pi' && !selectedModel)}
          >
            {saving && <LoaderCircle size={14} className="spin" />}
            {saving ? 'Queuing…' : 'Start review'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialogRef}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="modal-title">{title}</h2>
          <button className="button icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={17} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export default App;
