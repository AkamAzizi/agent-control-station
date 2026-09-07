import { FormEvent, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { RepositoryRecord } from '../../../../src/types';
import { api, type Notice } from '../lib/station';
import { Modal } from '../components/Modal';

export function RepoModal({
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
