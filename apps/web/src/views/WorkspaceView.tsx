import { FormEvent, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleDot,
  Database,
  FileCode2,
  FolderGit2,
  GitBranch,
  Info,
  Layers3,
  LoaderCircle,
  MessageSquareText,
  PackageCheck,
  Pause,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  DEFAULT_POLICY,
  type ContextItem,
  type ContextPacket,
  type Feedback,
  type Finding,
  type JudgmentPack,
  type ReviewRequest,
  type Run,
  type RunEvent,
} from '../../../../src/types';
import {
  api,
  displayRef,
  formatBytes,
  formatDate,
  labelize,
  timeAgo,
  STATUS_LABELS,
  STATUS_TONES,
  type Notice,
  type RunDetail,
  type RunTab,
  type StationState,
} from '../lib/station';
import { EmptyState } from '../components/EmptyState';
import { StatusPill } from '../components/StatusPill';

export function WorkspaceView({
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
            <ul className="evidence-quotes">
              {finding.evidence.map((evidence) => (
                <li key={`${evidence.contextItemId}:${evidence.quote}`}>
                  <code>{evidence.contextItemId}</code>
                  <pre>{evidence.quote}</pre>
                </li>
              ))}
            </ul>
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
    String(
      Math.max(
        DEFAULT_POLICY.maxBytes / 1024,
        Math.round((run.request.policy?.maxBytes ?? DEFAULT_POLICY.maxBytes) / 1024),
      ),
    ),
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
