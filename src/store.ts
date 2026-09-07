import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  RepositoryRecord,
  Run,
  RunEvent,
  ContextPacket,
  Snapshot,
  JudgmentPack,
  Feedback,
} from './types.js';

export class Store {
  private db: DatabaseSync;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const dir of ['artifacts', 'packs', 'workers'])
      mkdirSync(join(directory, dir), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'station.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = Number(
      (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (version > 1) {
      this.db.close();
      throw new Error('This database needs a newer Agent Control Station.');
    }
    if (version === 0)
      this.db
        .exec(`BEGIN; CREATE TABLE repos(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
      CREATE TABLE runs(id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX events_run ON events(run_id,id);
      CREATE TABLE packs(id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE feedback(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, json TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
  }
  close() {
    this.db.close();
  }
  repos(): RepositoryRecord[] {
    return this.db
      .prepare('SELECT json FROM repos ORDER BY path')
      .all()
      .map((r) => JSON.parse(r.json as string));
  }
  repo(id: string): RepositoryRecord {
    const r = this.repos().find((r) => r.id === id);
    if (!r) throw new Error('Repository not found');
    return r;
  }
  addRepo(path: string, name: string): RepositoryRecord {
    const existing = this.repos().find((r) => r.path === path);
    if (existing) return existing;
    const r = { id: randomUUID(), name, path, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO repos VALUES(?,?,?)').run(r.id, path, JSON.stringify(r));
    return r;
  }
  runs(): Run[] {
    return this.db
      .prepare('SELECT json FROM runs ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(r.json as string));
  }
  run(id: string): Run {
    const row = this.db.prepare('SELECT json FROM runs WHERE id=?').get(id);
    if (!row) throw new Error('Run not found');
    return JSON.parse(row.json as string);
  }
  record(run: Run, type: string, data: Record<string, unknown> = {}): RunEvent {
    run.updatedAt = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json')
        .run(run.id, JSON.stringify(run));
      const result = this.db
        .prepare('INSERT INTO events(run_id,type,time,json) VALUES(?,?,?,?)')
        .run(run.id, type, run.updatedAt, JSON.stringify(data));
      this.db.exec('COMMIT');
      return { id: Number(result.lastInsertRowid), runId: run.id, type, time: run.updatedAt, data };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  events(after = 0, runId?: string): RunEvent[] {
    const rows = runId
      ? this.db
          .prepare('SELECT * FROM events WHERE id>? AND run_id=? ORDER BY id')
          .all(after, runId)
      : this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id').all(after);
    return rows.map((r) => ({
      id: Number(r.id),
      runId: r.run_id as string,
      type: r.type as string,
      time: r.time as string,
      data: JSON.parse(r.json as string),
    }));
  }
  artifact(kind: 'context' | 'snapshot', id: string, value?: ContextPacket | Snapshot): any {
    if (!/^[a-f0-9]{16,128}$/.test(id)) throw new Error('Invalid artifact identifier');
    const path = join(this.directory, 'artifacts', `${kind}-${id}.json`);
    if (value && !existsSync(path)) {
      const tmp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      renameSync(tmp, path);
    }
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }
  packs(): JudgmentPack[] {
    return this.db
      .prepare(
        'SELECT p.json FROM packs p JOIN (SELECT id,MAX(version) version FROM packs GROUP BY id) latest ON p.id=latest.id AND p.version=latest.version ORDER BY p.id',
      )
      .all()
      .map((r) => JSON.parse(r.json as string));
  }
  savePack(pack: JudgmentPack): JudgmentPack {
    const prev = this.packs().find((p) => p.id === pack.id);
    if (pack.version !== (prev?.version ?? 0) + 1)
      throw new Error('Pack versions are immutable; save the next version.');
    const markdown =
      `---\n${JSON.stringify(pack, null, 2)}\n---\n\n# ${pack.name}\n\nHistorical judgment examples; current code facts come from the run snapshot.\n\n` +
      pack.rules
        .map(
          (r) =>
            `## ${r.id}\n\n${r.text}\n${r.goodExample ? `\n### Good example\n\n\x60\x60\x60\n${r.goodExample}\n\x60\x60\x60\n` : ''}${r.badExample ? `\n### Bad example\n\n\x60\x60\x60\n${r.badExample}\n\x60\x60\x60\n` : ''}`,
        )
        .join('\n');
    writeFileSync(join(this.directory, 'packs', `${pack.id}-v${pack.version}.md`), markdown, {
      mode: 0o600,
    });
    this.db
      .prepare('INSERT INTO packs VALUES(?,?,?)')
      .run(pack.id, pack.version, JSON.stringify(pack));
    return pack;
  }
  feedback(runId: string): Feedback[] {
    return this.db
      .prepare('SELECT json FROM feedback WHERE run_id=? ORDER BY rowid')
      .all(runId)
      .map((r) => JSON.parse(r.json as string));
  }
  addFeedback(input: Omit<Feedback, 'id' | 'createdAt'>): Feedback {
    const run = this.run(input.runId);
    if (!run.findings.some((f) => f.id === input.findingId)) throw new Error('Finding not found');
    const feedback = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO feedback VALUES(?,?,?)')
      .run(feedback.id, feedback.runId, JSON.stringify(feedback));
    return feedback;
  }
}
