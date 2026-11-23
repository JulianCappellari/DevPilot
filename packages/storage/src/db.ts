import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type DB = DatabaseSync;
export type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user(
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), token_hash TEXT UNIQUE NOT NULL,
  csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, ip TEXT, user_agent TEXT);
CREATE TABLE IF NOT EXISTS allowed_root(
  id TEXT PRIMARY KEY, canonical_path TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, root_id TEXT NOT NULL REFERENCES allowed_root(id),
  repo_path TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', enabled_checks TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), title TEXT NOT NULL, description TEXT,
  type TEXT NOT NULL, priority TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'DRAFT', version INTEGER NOT NULL DEFAULT 1,
  classification TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS task_project ON task(project_id, state);
CREATE TABLE IF NOT EXISTS task_label(
  task_id TEXT NOT NULL REFERENCES task(id), label TEXT NOT NULL, PRIMARY KEY(task_id,label));
CREATE TABLE IF NOT EXISTS task_dependency(
  task_id TEXT NOT NULL REFERENCES task(id), prerequisite_id TEXT NOT NULL REFERENCES task(id),
  PRIMARY KEY(task_id,prerequisite_id), CHECK(task_id<>prerequisite_id));
CREATE TABLE IF NOT EXISTS acceptance_criterion(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), text TEXT NOT NULL, position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS task_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES task(id), from_state TEXT, to_state TEXT NOT NULL,
  actor_id TEXT, reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), provider_id TEXT NOT NULL, state TEXT NOT NULL,
  attempt INTEGER NOT NULL, worktree_path TEXT, branch TEXT, base_commit TEXT, diff_hash TEXT, delivered_commit TEXT,
  version INTEGER NOT NULL DEFAULT 1, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, external_ack INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, UNIQUE(task_id, attempt));
CREATE INDEX IF NOT EXISTS run_task_state ON run(task_id, state);
CREATE TABLE IF NOT EXISTS job(
  id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL REFERENCES run(id), state TEXT NOT NULL, lease_until TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_event(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES run(id), seq INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, seq));
CREATE TABLE IF NOT EXISTS quality_check(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id), command_id TEXT NOT NULL, exit_code INTEGER,
  state TEXT NOT NULL, duration_ms INTEGER NOT NULL, stdout TEXT NOT NULL, stderr TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_diff(
  run_id TEXT PRIMARY KEY REFERENCES run(id), files TEXT NOT NULL, patch TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approval(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id), action TEXT NOT NULL, diff_hash TEXT, expires_at TEXT NOT NULL,
  decision TEXT NOT NULL, consumed_at TEXT, actor_id TEXT, reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_event(
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
  outcome TEXT NOT NULL, detail TEXT, correlation_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pull_request(
  run_id TEXT PRIMARY KEY REFERENCES run(id), commit_sha TEXT NOT NULL,
  url TEXT NOT NULL, number INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS context_file(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), path TEXT NOT NULL,
  sha256 TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_id, path));
CREATE TABLE IF NOT EXISTS context_proposal(
  task_id TEXT PRIMARY KEY REFERENCES task(id), file_id TEXT NOT NULL REFERENCES context_file(id),
  path TEXT NOT NULL, base_sha256 TEXT NOT NULL, content TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS manual_review(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id), diff_hash TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES user(id), findings TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS manual_review_run ON manual_review(run_id,created_at);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_event BEGIN SELECT RAISE(ABORT, 'audit_event es append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_event BEGIN SELECT RAISE(ABORT, 'audit_event es append-only'); END;
CREATE TRIGGER IF NOT EXISTS run_event_no_update BEFORE UPDATE ON run_event BEGIN SELECT RAISE(ABORT, 'run_event es append-only'); END;
`;

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  tx(db, () => {
    const columns = new Map([
      ["run", [
        ["external_ack", "INTEGER NOT NULL DEFAULT 0"],
        ["requested_task_version", "INTEGER"],
        ["requested_project_version", "INTEGER"],
        ["write_scope", "INTEGER"],
        ["cost_origin", "TEXT"],
      ]],
      ["quality_check", [["environment", "TEXT"]]],
    ] as const);
    for (const [table, fields] of columns) {
      const names = new Set(all<{ name: string }>(db, `PRAGMA table_info(${table})`).map((column) => column.name));
      for (const [column, type] of fields) if (!names.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  });
  return db;
}

export const nowIso = (): string => new Date().toISOString();
export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

export function all<T = Row>(db: DB, sql: string, ...p: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...p) as unknown as T[];
}
export function get<T = Row>(db: DB, sql: string, ...p: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...p) as unknown as T | undefined;
}
export function run(db: DB, sql: string, ...p: SQLInputValue[]): { changes: number } {
  const r = db.prepare(sql).run(...p);
  return { changes: Number(r.changes) };
}

/** Transacción inmediata (toma el lock de escritura de entrada: evita carreras de lectura-escritura). */
const OPEN_TX = new WeakSet<DB>();
export function tx<T>(db: DB, fn: () => T): T {
  if (OPEN_TX.has(db)) return fn(); // reentrante: participa de la transacción externa
  db.exec("BEGIN IMMEDIATE");
  OPEN_TX.add(db);
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    OPEN_TX.delete(db);
  }
}

export function backupTo(db: DB, dest: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  db.prepare("VACUUM INTO ?").run(dest);
}
