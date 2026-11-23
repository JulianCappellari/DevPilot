import type { FastifyInstance } from "fastify";
import { ok } from "@devpilot/contracts";
import { RUN_STATES, TASK_STATES } from "@devpilot/domain";
import { all, audit, get, type DB } from "@devpilot/storage";

const duration = "ROUND(AVG(CASE WHEN r.finished_at IS NOT NULL AND r.started_at IS NOT NULL THEN MAX(0,(julianday(r.finished_at)-julianday(r.started_at))*86400000) END))";

function reports(db: DB) {
  return {
    tasks: all<{ state: string; count: number }>(db, "SELECT state, COUNT(*) AS count FROM task GROUP BY state ORDER BY state"),
    runs: all<{ state: string; count: number; averageMs: number | null }>(db,
      `SELECT r.state, COUNT(*) AS count, ${duration} AS averageMs FROM run r GROUP BY r.state ORDER BY r.state`),
    checks: all<{ state: string; count: number; averageMs: number }>(db,
      "SELECT state, COUNT(*) AS count, ROUND(AVG(duration_ms)) AS averageMs FROM quality_check GROUP BY state ORDER BY state"),
    projects: get<{ count: number }>(db, "SELECT COUNT(*) AS count FROM project")!.count,
    costs: all<{ origin: string; count: number }>(db,
      "SELECT COALESCE(cost_origin,'UNKNOWN') AS origin,COUNT(*) AS count FROM run GROUP BY origin ORDER BY origin"),
  };
}

export function registerReports(app: FastifyInstance, db: DB, prefix: string) {
  app.get(`${prefix}/reports`, async (req) => ok({
    ...reports(db),
    providers: all<{ id: string; finished: number; succeeded: number; averageMs: number | null }>(db, `
      SELECT r.provider_id AS id, COUNT(r.finished_at) AS finished,
        SUM(CASE WHEN r.state='SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded, ${duration} AS averageMs
      FROM run r GROUP BY r.provider_id ORDER BY r.provider_id`),
  }, req.id));

  app.post(`${prefix}/reports/portfolio`, async (req) => {
    const summary = reports(db);
    const table = (heading: string, rows: { state: string; count: number; averageMs?: number | null }[]) => [
      `## ${heading}`, "", "| Estado | Total | Duración media (ms) |", "| --- | ---: | ---: |",
      ...rows.map(({ state, count, averageMs }) => `| ${state} | ${count} | ${averageMs ?? "—"} |`), "",
    ];
    const safe = (rows: Parameters<typeof table>[1], states: readonly string[]) => rows.map((row) =>
      ({ ...row, state: states.includes(row.state) ? row.state : "UNKNOWN" }));
    const document = [
      "# Informe técnico de DevPilot", "", `Proyectos registrados: ${summary.projects}`, "",
      ...table("Tareas", safe(summary.tasks, TASK_STATES)), ...table("Ejecuciones", safe(summary.runs, RUN_STATES)),
      ...table("Checks", safe(summary.checks, ["PASSED", "FAILED", "TIMED_OUT", "UNKNOWN"])),
      ...table("Consumo declarado por origen", safe(summary.costs.map(({ origin, count }) => ({ state: origin, count })), ["LOCAL", "SUBSCRIPTION_QUOTA", "PAID_API"])),
      "El consumo se expresa en cantidad de ejecuciones registradas. Los montos y las cuotas se consultan en cada proveedor.", "",
    ].join("\n");
    audit(db, { actorId: req.auth!.userId, action: "report.export", entityType: "portfolio", outcome: "OK", correlationId: req.id });
    return ok({ markdown: document }, req.id);
  });
}
