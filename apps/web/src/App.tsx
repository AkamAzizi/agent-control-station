import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Code2,
  FolderGit2,
  GitBranch,
  Layers3,
  Menu,
  PanelLeft,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import type { JudgmentPack, RepositoryRecord, ReviewRequest, Run } from '../../../src/types';
import {
  api,
  type Notice,
  type RunDetail,
  type RunTab,
  type StationState,
  type View,
} from './lib/station';
import { WorkspaceView } from './views/WorkspaceView';
import { RepositoriesView } from './views/RepositoriesView';
import { PacksView } from './views/PacksView';
import { RepoModal } from './views/RepoModal';
import { ReviewModal } from './views/ReviewModal';

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

export default App;
