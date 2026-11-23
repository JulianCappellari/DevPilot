import { transitionRun, transitionTask, type RunState, type TaskState } from "@devpilot/domain";
import { get, nowIso, run, tx, type DB } from "./db.js";

export type TaskRow = { id: string; project_id: string; title: string; description: string | null; type: string; priority: string; state: TaskState; version: number; classification: string | null; archived: number; created_at: string; updated_at: string };
export type RunRow = { id: string; task_id: string; provider_id: string; state: RunState; attempt: number; worktree_path: string | null; branch: string | null; base_commit: string | null; diff_hash: string | null; delivered_commit: string | null; version: number; error: string | null; cancel_requested: number; created_at: string; started_at: string | null; finished_at: string | null };
export type ProjectRow = { id: string; name: string; root_id: string; repo_path: string; status: "ACTIVE" | "INACTIVE" | "ARCHIVED"; enabled_checks: string; version: number; created_at: string; updated_at: string };

export const getTask = (db: DB, id: string) => get<TaskRow>(db, "SELECT * FROM task WHERE id = ?", id);
export const getRun = (db: DB, id: string) => get<RunRow>(db, "SELECT * FROM run WHERE id = ?", id);
export const getProject = (db: DB, id: string) => get<ProjectRow>(db, "SELECT * FROM project WHERE id = ?", id);

/** Transición de tarea validada + CAS de versión + historial (RF-008). Lanza si es inválida o hay conflicto. */
export function applyTaskTransition(db: DB, taskId: string, to: TaskState, actorId: string | null, reason: string | null, expectedVersion?: number): TaskRow {
  return tx(db, () => {
    const cur = getTask(db, taskId);
    if (!cur) throw new Error("task not found");
    const next = transitionTask(cur, to, expectedVersion ?? cur.version);
    const r = run(db, "UPDATE task SET state=?, version=?, updated_at=? WHERE id=? AND version=?", next.state, next.version, nowIso(), taskId, cur.version);
    if (r.changes !== 1) throw new Error("task update lost");
    run(db, "INSERT INTO task_history(task_id,from_state,to_state,actor_id,reason,created_at) VALUES(?,?,?,?,?,?)", taskId, cur.state, to, actorId, reason, nowIso());
    return next;
  });
}

export function applyRunTransition(db: DB, runId: string, to: RunState, extra: { error?: string | null; started?: boolean; finished?: boolean } = {}): RunRow {
  return tx(db, () => {
    const cur = getRun(db, runId);
    if (!cur) throw new Error("run not found");
    const next = transitionRun(cur, to, cur.version);
    const now = nowIso();
    const r = run(db,
      "UPDATE run SET state=?, version=?, error=COALESCE(?, error), started_at=CASE WHEN ? THEN ? ELSE started_at END, finished_at=CASE WHEN ? THEN ? ELSE finished_at END WHERE id=? AND version=?",
      next.state, next.version, extra.error ?? null, extra.started ? 1 : 0, now, extra.finished ? 1 : 0, now, runId, cur.version);
    if (r.changes !== 1) throw new Error("run update lost");
    return next;
  });
}
