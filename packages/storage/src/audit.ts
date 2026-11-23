import { redactSecrets } from "@devpilot/security";
import { nowIso, run, type DB } from "./db.js";

export type AuditInput = {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  outcome: "OK" | "DENIED" | "FAILED";
  detail?: Record<string, unknown>;
  correlationId?: string;
};

/** Registro append-only (RF-026). El detalle se redacta; nunca se serializan secretos (§9.2). */
export function audit(db: DB, e: AuditInput): void {
  const detail = e.detail ? redactSecrets(JSON.stringify(e.detail)).slice(0, 4000) : null;
  run(db, "INSERT INTO audit_event(actor_id,action,entity_type,entity_id,outcome,detail,correlation_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
    e.actorId, e.action, e.entityType, e.entityId ?? null, e.outcome, detail, e.correlationId ?? null, nowIso());
}
