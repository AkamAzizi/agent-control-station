import { FormEvent, useState } from 'react';
import { AlertCircle, FileCode2, Layers3, LoaderCircle, Plus, X } from 'lucide-react';
import type { JudgmentPack } from '../../../../src/types';
import { api, type Notice } from '../lib/station';

export function PacksView({
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
