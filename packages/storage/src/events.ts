import { redactSecrets } from "@devpilot/security";
import { all, get, nowIso, run, tx, type DB } from "./db.js";

/** Añade un evento con `seq` monótono por run (Unique(runId,seq)). Payload redactado (RF-016). */
export function appendRunEvent(db: DB, runId: string, type: string, payload: Record<string, unknown>): number {
  const text = redactSecrets(JSON.stringify(payload)).slice(0, 16_000);
  return tx(db, () => {
    const seq = (get<{ m: number | null }>(db, "SELECT MAX(seq) AS m FROM run_event WHERE run_id = ?", runId)?.m ?? 0) + 1;
    run(db, "INSERT INTO run_event(run_id,seq,type,payload,created_at) VALUES(?,?,?,?,?)", runId, seq, type, text, nowIso());
    return seq;
  });
}

export type StoredRunEvent = { seq: number; type: string; payload: string; created_at: string };

export const listRunEventsAfter = (db: DB, runId: string, afterSeq: number, limit = 500): StoredRunEvent[] =>
  all<StoredRunEvent>(db, "SELECT seq,type,payload,created_at FROM run_event WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?", runId, afterSeq, limit);
