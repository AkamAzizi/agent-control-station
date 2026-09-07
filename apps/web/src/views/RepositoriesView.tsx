import { ArrowDownToLine, FolderGit2, Plus } from 'lucide-react';
import type { RepositoryRecord } from '../../../../src/types';
import { formatDate } from '../lib/station';

export function RepositoriesView({
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
