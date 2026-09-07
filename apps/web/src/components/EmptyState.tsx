import { LoaderCircle, Play, Plus, Sparkles } from 'lucide-react';

type EmptyStateProps = {
  onDemo: () => void;
  onNew: () => void;
  demoBusy?: boolean;
};

export function EmptyState({ onDemo, onNew, demoBusy }: EmptyStateProps) {
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
