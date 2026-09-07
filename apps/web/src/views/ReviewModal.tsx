import { FormEvent, useState } from 'react';
import {
  ChevronRight,
  GitBranch,
  Info,
  LoaderCircle,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import type { ReviewRequest, Run } from '../../../../src/types';
import { api, modelOptionKey, type Notice, type StationState } from '../lib/station';
import { Modal } from '../components/Modal';

export function ReviewModal({
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
