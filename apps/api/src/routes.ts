import { mkdirSync, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreateTaskInputSchema, formatSse, ok, parseEventCursor, type RunEventType } from "@devpilot/contracts";
import {
  TASK_STATES, canMarkQaPassed, canRequestExecution, canUseProvider, canTransitionTask, cancelRun, consumeApproval, isTerminalRun,
  validateApproval, type Approval, type CheckState, type CostOrigin, type TaskState,
} from "@devpilot/domain";
import { commitAll, gitStatus, removeWorktree, snapshotDiff, topLevel } from "@devpilot/runner";
import { containsSecret, isSensitivePath, redactSecrets, resolveInsideAnyRoot, resolveInsideRoot, PathPolicyError } from "@devpilot/security";
import {
  all, applyRunTransition, applyTaskTransition, audit, get, getProject, getRun, getTask, listRunEventsAfter, newId, nowIso, run, tx,
  type DB, type ProjectRow, type RunRow, type TaskRow,
} from "@devpilot/storage";
import type { AppDeps } from "./app.js";
import { AppError } from "./errors.js";
import { classifyTask, listOllamaModels } from "./classify.js";

const IdParam = z.object({ id: z.string().min(1).max(64) });
const CHECKS = z.array(z.enum(["lint", "test", "typecheck"])).max(3);
const VersionedPatch = z.object({ version: z.number().int().positive() });
const APPROVAL_TTL_MS = 5 * 60_000;

const parseCriteria = (db: DB, taskId: string) =>
  all<{ id: string; text: string; position: number }>(db, "SELECT id, text, position FROM acceptance_criterion WHERE task_id = ? ORDER BY position", taskId);

const taskView = (db: DB, t: TaskRow) => ({
  id: t.id, projectId: t.project_id, title: t.title, description: t.description, type: t.type, priority: t.priority, state: t.state,
  version: t.version, archived: !!t.archived, createdAt: t.created_at, updatedAt: t.updated_at,
  classification: t.classification ? JSON.parse(t.classification) : null,
  acceptanceCriteria: parseCriteria(db, t.id).map((c) => c.text),
});

const projectView = (p: ProjectRow) => ({
  id: p.id, name: p.name, status: p.status, version: p.version, enabledChecks: JSON.parse(p.enabled_checks) as string[],
  rootId: p.root_id, path: p.repo_path, createdAt: p.created_at,
});

const runView = (r: RunRow) => ({
  id: r.id, taskId: r.task_id, providerId: r.provider_id, state: r.state, attempt: r.attempt, branch: r.branch, baseCommit: r.base_commit,
  diffHash: r.diff_hash, deliveredCommit: r.delivered_commit, error: r.error, cancelRequested: !!r.cancel_requested,
  createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, version: r.version,
});

export function registerDomainRoutes(app: FastifyInstance, deps: AppDeps, P: string): void {
  const { db, config, providers } = deps;
  const must = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new AppError("NOT_FOUND", `${what} no encontrado`); return v; };

  // ---------- Roots autorizados (RN-001, CU-01) ----------
  const enabledRoots = () => all<{ id: string; canonical_path: string }>(db, "SELECT id, canonical_path FROM allowed_root WHERE enabled = 1");

  app.get(`${P}/roots`, async (req) => ok(all(db, "SELECT id, canonical_path AS path, enabled, created_at AS createdAt FROM allowed_root ORDER BY created_at"), req.id));
  app.post(`${P}/roots`, async (req) => {
    const { path: p } = z.object({ path: z.string().min(1).max(500) }).strict().parse(req.body);
    let st;
    try { st = statSync(p); } catch { throw new AppError("NOT_FOUND", "La carpeta no existe"); }
    if (!st.isDirectory()) throw new AppError("VALIDATION", "La ruta no es una carpeta");
    const { realpath } = await import("node:fs/promises");
    const canonical = await realpath(p);
    const id = newId("root");
    run(db, "INSERT OR IGNORE INTO allowed_root(id,canonical_path,enabled,created_at) VALUES(?,?,1,?)", id, canonical, nowIso());
    audit(db, { actorId: req.auth!.userId, action: "root.add", entityType: "allowed_root", entityId: id, outcome: "OK", detail: { path: canonical }, correlationId: req.id });
    return ok(get(db, "SELECT id, canonical_path AS path, enabled FROM allowed_root WHERE canonical_path = ?", canonical), req.id);
  });
  app.patch(`${P}/roots/:id`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    must(get(db, "SELECT id FROM allowed_root WHERE id=?", id), "Root");
    run(db, "UPDATE allowed_root SET enabled=? WHERE id=?", enabled ? 1 : 0, id);
    audit(db, { actorId: req.auth!.userId, action: "root.toggle", entityType: "allowed_root", entityId: id, outcome: "OK", detail: { enabled }, correlationId: req.id });
    return ok({ id, enabled }, req.id);
  });

  // ---------- Proyectos ----------
  app.get(`${P}/projects`, async (req) => {
    const rows = all<ProjectRow>(db, "SELECT * FROM project ORDER BY name");
    return ok(rows.map((p) => ({
      ...projectView(p),
      openTasks: get<{ n: number }>(db, "SELECT COUNT(*) n FROM task WHERE project_id=? AND archived=0 AND state NOT IN ('APPROVED','REJECTED')", p.id)?.n ?? 0,
    })), req.id);
  });

  app.post(`${P}/projects`, async (req) => {
    const b = z.object({ name: z.string().trim().min(1).max(100), repoPath: z.string().min(1).max(500), enabledChecks: CHECKS.default([]) }).strict().parse(req.body);
    let resolved: { root: string; resolved: string };
    try {
      resolved = await resolveInsideAnyRoot(enabledRoots().map((r) => r.canonical_path), b.repoPath);
    } catch (e) {
      audit(db, { actorId: req.auth!.userId, action: "project.register", entityType: "project", outcome: "DENIED", detail: { reason: e instanceof PathPolicyError ? e.code : "error" }, correlationId: req.id });
      throw e;
    }
    // Debe ser la raíz de un repositorio Git (no una subcarpeta ni un repo anidado distinto).
    let top: string;
    try { top = await topLevel(resolved.resolved); } catch { throw new AppError("VALIDATION", "La carpeta no es un repositorio Git"); }
    const canonicalTop = await resolveInsideRoot(resolved.root, top).catch(() => { throw new AppError("FORBIDDEN", "El repositorio está fuera de las raíces autorizadas", true); });
    if (canonicalTop.toLowerCase() !== resolved.resolved.toLowerCase()) throw new AppError("VALIDATION", "Indicá la carpeta raíz del repositorio");
    const rootId = enabledRoots().find((r) => r.canonical_path === resolved.root)!.id;
    if (get(db, "SELECT id FROM project WHERE repo_path = ?", resolved.resolved)) throw new AppError("INVALID_STATE", "El repositorio ya está registrado");
    const id = newId("prj");
    const now = nowIso();
    run(db, "INSERT INTO project(id,name,root_id,repo_path,status,enabled_checks,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)", id, b.name, rootId, resolved.resolved, "ACTIVE", JSON.stringify(b.enabledChecks), now, now);
    audit(db, { actorId: req.auth!.userId, action: "project.register", entityType: "project", entityId: id, outcome: "OK", correlationId: req.id });
    return ok(projectView(getProject(db, id)!), req.id);
  });

  app.get(`${P}/projects/:id`, async (req) => ok(projectView(must(getProject(db, IdParam.parse(req.params).id), "Proyecto")), req.id));

  app.patch(`${P}/projects/:id`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = VersionedPatch.extend({ name: z.string().trim().min(1).max(100).optional(), status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional(), enabledChecks: CHECKS.optional() }).strict().parse(req.body);
    const p = must(getProject(db, id), "Proyecto");
    const r = run(db, "UPDATE project SET name=?, status=?, enabled_checks=?, version=version+1, updated_at=? WHERE id=? AND version=?",
      b.name ?? p.name, b.status ?? p.status, JSON.stringify(b.enabledChecks ?? JSON.parse(p.enabled_checks)), nowIso(), id, b.version);
    if (r.changes !== 1) throw new AppError("VERSION_CONFLICT", "El proyecto cambió; recargá y reintentá");
    audit(db, { actorId: req.auth!.userId, action: "project.update", entityType: "project", entityId: id, outcome: "OK", detail: { status: b.status, checks: b.enabledChecks }, correlationId: req.id });
    return ok(projectView(getProject(db, id)!), req.id);
  });

  app.get(`${P}/projects/:id/git`, async (req) => {
    const p = must(getProject(db, IdParam.parse(req.params).id), "Proyecto");
    // Revalida la ruta contra los roots antes de tocar el FS (TOCTOU, RN-016).
    await resolveInsideAnyRoot(enabledRoots().map((r) => r.canonical_path), p.repo_path);
    return ok(await gitStatus(p.repo_path), req.id);
  });

  app.get(`${P}/projects/:id/tasks`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const q = z.object({ state: z.enum(TASK_STATES).optional(), q: z.string().max(100).optional(), archived: z.enum(["true", "false"]).default("false"), sort: z.enum(["priority", "updated", "created"]).default("updated") }).parse(req.query);
    must(getProject(db, id), "Proyecto");
    const order = q.sort === "priority" ? "CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC" : q.sort === "created" ? "created_at DESC" : "updated_at DESC";
    const rows = all<TaskRow>(db, `SELECT * FROM task WHERE project_id=? AND archived=? AND (? IS NULL OR state=?) AND (? IS NULL OR title LIKE ? ESCAPE '\\') ORDER BY ${order} LIMIT 500`,
      id, q.archived === "true" ? 1 : 0, q.state ?? null, q.state ?? null, q.q ?? null, q.q ? `%${q.q.replace(/[\\%_]/g, "\\$&")}%` : null);
    return ok(rows.map((t) => taskView(db, t)), req.id);
  });

  // ---------- Tareas ----------
  app.post(`${P}/tasks`, async (req) => {
    const b = CreateTaskInputSchema.parse(req.body);
    const p = must(getProject(db, b.projectId), "Proyecto");
    if (p.status === "ARCHIVED") throw new AppError("INVALID_STATE", "El proyecto está archivado");
    const id = newId("tsk");
    const now = nowIso();
    const state: TaskState = b.acceptanceCriteria.length > 0 ? "READY" : "DRAFT"; // CU-02
    tx(db, () => {
      run(db, "INSERT INTO task(id,project_id,title,description,type,priority,state,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)", id, p.id, b.title, b.description ?? null, b.type, b.priority, state, now, now);
      b.acceptanceCriteria.forEach((t, i) => run(db, "INSERT INTO acceptance_criterion(id,task_id,text,position) VALUES(?,?,?,?)", newId("ac"), id, t, i));
      run(db, "INSERT INTO task_history(task_id,from_state,to_state,actor_id,reason,created_at) VALUES(?,?,?,?,?,?)", id, null, state, req.auth!.userId, "creación", now);
      audit(db, { actorId: req.auth!.userId, action: "task.create", entityType: "task", entityId: id, outcome: "OK", correlationId: req.id });
    });
    return ok(taskView(db, getTask(db, id)!), req.id);
  });

  app.get(`${P}/tasks/:id`, async (req) => {
    const t = must(getTask(db, IdParam.parse(req.params).id), "Tarea");
    const history = all(db, "SELECT from_state AS \"from\", to_state AS \"to\", actor_id AS actorId, reason, created_at AS at FROM task_history WHERE task_id=? ORDER BY id", t.id);
    const runs = all<RunRow>(db, "SELECT * FROM run WHERE task_id=? ORDER BY attempt DESC", t.id).map(runView);
    return ok({ ...taskView(db, t), history, runs, project: projectView(getProject(db, t.project_id)!) }, req.id);
  });

  app.patch(`${P}/tasks/:id`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = VersionedPatch.extend({
      title: z.string().trim().min(3).max(200).optional(), description: z.string().max(10_000).nullable().optional(),
      type: CreateTaskInputSchema.shape.type.optional(), priority: CreateTaskInputSchema.shape.priority.optional(),
      acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    }).strict().parse(req.body);
    const t = must(getTask(db, id), "Tarea");
    if (!["DRAFT", "READY", "NEEDS_CHANGES", "FAILED", "CANCELLED", "TIMED_OUT", "UNKNOWN"].includes(t.state)) throw new AppError("INVALID_STATE", `No se puede editar una tarea en estado ${t.state}`);
    tx(db, () => {
      const r = run(db, "UPDATE task SET title=?, description=?, type=?, priority=?, version=version+1, updated_at=? WHERE id=? AND version=?",
        b.title ?? t.title, b.description === undefined ? t.description : b.description, b.type ?? t.type, b.priority ?? t.priority, nowIso(), id, b.version);
      if (r.changes !== 1) throw new AppError("VERSION_CONFLICT", "La tarea cambió; recargá y reintentá");
      if (b.acceptanceCriteria) {
        run(db, "DELETE FROM acceptance_criterion WHERE task_id=?", id);
        b.acceptanceCriteria.forEach((x, i) => run(db, "INSERT INTO acceptance_criterion(id,task_id,text,position) VALUES(?,?,?,?)", newId("ac"), id, x, i));
      }
      audit(db, { actorId: req.auth!.userId, action: "task.update", entityType: "task", entityId: id, outcome: "OK", correlationId: req.id });
    });
    return ok(taskView(db, getTask(db, id)!), req.id);
  });

  app.post(`${P}/tasks/:id/transition`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = VersionedPatch.extend({ to: z.enum(["DRAFT", "READY"]), reason: z.string().max(300).optional() }).strict().parse(req.body);
    const t = must(getTask(db, id), "Tarea");
    if (!canTransitionTask(t.state, b.to)) throw new AppError("INVALID_STATE", `Transición inválida: ${t.state} -> ${b.to}`);
    if (b.to === "READY" && parseCriteria(db, id).length === 0) throw new AppError("INVALID_STATE", "La tarea necesita criterios de aceptación para estar lista (RN-005)");
    const n = applyTaskTransition(db, id, b.to, req.auth!.userId, b.reason ?? null, b.version);
    audit(db, { actorId: req.auth!.userId, action: "task.transition", entityType: "task", entityId: id, outcome: "OK", detail: { from: t.state, to: b.to }, correlationId: req.id });
    return ok(taskView(db, n), req.id);
  });

  app.post(`${P}/tasks/:id/archive`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const t = must(getTask(db, id), "Tarea");
    if (["QUEUED", "RUNNING"].includes(t.state)) throw new AppError("INVALID_STATE", "No se puede archivar una tarea en ejecución");
    run(db, "UPDATE task SET archived=1, updated_at=? WHERE id=?", nowIso(), id); // se archiva, no se borra (§9.2)
    audit(db, { actorId: req.auth!.userId, action: "task.archive", entityType: "task", entityId: id, outcome: "OK", correlationId: req.id });
    return ok({ id, archived: true }, req.id);
  });

  app.post(`${P}/tasks/:id/classify`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const t = must(getTask(db, id), "Tarea");
    const c = await classifyTask({ title: t.title, description: t.description, acceptanceCriteria: parseCriteria(db, id).map((x) => x.text) }, config);
    run(db, "UPDATE task SET classification=? WHERE id=?", JSON.stringify(c), id); // propuesta, no cambia permisos ni estado (RN-006)
    audit(db, { actorId: req.auth!.userId, action: "task.classify", entityType: "task", entityId: id, outcome: "OK", detail: { source: c.source }, correlationId: req.id });
    return ok(c, req.id);
  });

  // ---------- Runs ----------
  const providerOrigin = async (pid: string): Promise<CostOrigin> => (await must(providers.get(pid), "Proveedor").capabilities()).costOrigin;

  app.post(`${P}/tasks/:id/runs`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const { providerId } = z.object({ providerId: z.string().min(1).max(50) }).strict().parse(req.body);
    const t = must(getTask(db, id), "Tarea");
    const p = must(getProject(db, t.project_id), "Proyecto");
    if (t.state !== "READY") throw new AppError("INVALID_STATE", `La tarea debe estar READY (está ${t.state})`);
    const policy = canRequestExecution({ projectStatus: p.status, acceptanceCriteria: parseCriteria(db, id).map((c) => c.text), scopeDefined: !!(t.description?.trim() || parseCriteria(db, id).length) });
    if (!policy.ok) throw new AppError("INVALID_STATE", policy.reason);
    const origin = await providerOrigin(providerId);
    const gate = canUseProvider(origin, providerId, { enablePaidApis: config.enablePaidApis, paidProviderConsent: new Set() });
    if (!gate.ok) throw new AppError("FORBIDDEN", gate.reason, true);
    const active = get(db, "SELECT id FROM run WHERE task_id=? AND state IN ('PENDING_APPROVAL','QUEUED','RUNNING')", id);
    if (active) throw new AppError("INVALID_STATE", "La tarea ya tiene una ejecución activa");
    const attempt = (get<{ m: number | null }>(db, "SELECT MAX(attempt) m FROM run WHERE task_id=?", id)?.m ?? 0) + 1;
    const runId = newId("run");
    run(db, "INSERT INTO run(id,task_id,provider_id,state,attempt,version,created_at) VALUES(?,?,?,'PENDING_APPROVAL',?,1,?)", runId, id, providerId, attempt, nowIso());
    audit(db, { actorId: req.auth!.userId, action: "run.request", entityType: "run", entityId: runId, outcome: "OK", detail: { providerId, origin }, correlationId: req.id });
    return ok(runView(getRun(db, runId)!), req.id);
  });

  app.get(`${P}/runs/:id`, async (req) => {
    const r = must(getRun(db, IdParam.parse(req.params).id), "Ejecución");
    const t = getTask(db, r.task_id)!;
    const checks = all(db, "SELECT id, command_id AS commandId, exit_code AS exitCode, state, duration_ms AS durationMs, created_at AS createdAt FROM quality_check WHERE run_id=? ORDER BY created_at", r.id);
    const approvals = all(db, "SELECT id, action, decision, diff_hash AS diffHash, expires_at AS expiresAt, reason, created_at AS createdAt FROM approval WHERE run_id=? ORDER BY created_at", r.id);
    return ok({ ...runView(r), task: { id: t.id, title: t.title, state: t.state, version: t.version, projectId: t.project_id }, checks, approvals }, req.id);
  });

  app.post(`${P}/runs/:id/approve-start`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const r = must(getRun(db, id), "Ejecución");
    if (r.state !== "PENDING_APPROVAL") throw new AppError("INVALID_STATE", `La ejecución está ${r.state}`);
    const t = getTask(db, r.task_id)!;
    const p = getProject(db, t.project_id)!;
    if (p.status !== "ACTIVE") throw new AppError("INVALID_STATE", "El proyecto no está activo (RN-002)");
    tx(db, () => {
      const now = nowIso();
      run(db, "INSERT INTO approval(id,run_id,action,diff_hash,expires_at,decision,consumed_at,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)", newId("apr"), id, "start_run", null, new Date(Date.now() + APPROVAL_TTL_MS).toISOString(), "APPROVED", now, req.auth!.userId, now);
      applyRunTransition(db, id, "QUEUED");
      applyTaskTransition(db, t.id, "QUEUED", req.auth!.userId, "inicio aprobado");
      run(db, "INSERT INTO job(id,run_id,state,retry_count,idempotency_key,created_at) VALUES(?,?,'QUEUED',0,?,?)", newId("job"), id, `run:${id}`, now);
      audit(db, { actorId: req.auth!.userId, action: "run.approve_start", entityType: "run", entityId: id, outcome: "OK", correlationId: req.id });
    });
    return ok(runView(getRun(db, id)!), req.id);
  });

  app.post(`${P}/runs/:id/cancel`, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const r = must(getRun(db, id), "Ejecución");
    if (isTerminalRun(r.state)) return ok({ ...runView(r), alreadyFinished: true }, req.id); // carrera con la finalización (CU-05)
    if (r.state === "RUNNING") {
      run(db, "UPDATE run SET cancel_requested=1 WHERE id=?", id);
      audit(db, { actorId: req.auth!.userId, action: "run.cancel_requested", entityType: "run", entityId: id, outcome: "OK", correlationId: req.id });
      reply.status(202);
      return ok({ ...runView(getRun(db, id)!), cancelling: true }, req.id);
    }
    tx(db, () => {
      const cur = cancelRun(getRun(db, id)!);
      if (cur.state === "CANCELLED") {
        applyRunTransition(db, id, "CANCELLED", { finished: true, error: "Cancelada por el usuario" });
        run(db, "UPDATE job SET state='DONE' WHERE run_id=?", id);
        const t = getTask(db, r.task_id)!;
        if (t.state === "QUEUED") applyTaskTransition(db, t.id, "CANCELLED", req.auth!.userId, "cancelada");
      }
      audit(db, { actorId: req.auth!.userId, action: "run.cancel", entityType: "run", entityId: id, outcome: "OK", correlationId: req.id });
    });
    return ok(runView(getRun(db, id)!), req.id);
  });

  // SSE con cursor `runId:seq` y reanudación por Last-Event-ID (ADR-003).
  app.get(`${P}/runs/:id/events`, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const r = must(getRun(db, id), "Ejecución");
    const q = z.object({ cursor: z.string().max(80).optional() }).parse(req.query);
    let cursor = parseEventCursor(String(req.headers["last-event-id"] ?? q.cursor ?? ""));
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    raw.write("retry: 1500\n\n");
    let closed = false;
    req.raw.on("close", () => { closed = true; });
    let idle = 0;
    while (!closed) {
      const evs = listRunEventsAfter(db, r.id, cursor);
      for (const e of evs) {
        raw.write(formatSse(e.type as RunEventType, r.id, e.seq, { ...JSON.parse(e.payload), at: e.created_at }));
        cursor = e.seq;
      }
      const cur = getRun(db, r.id)!;
      if (evs.length === 0 && isTerminalRun(cur.state) && listRunEventsAfter(db, r.id, cursor).length === 0) {
        raw.write(`event: run.end\ndata: ${JSON.stringify({ state: cur.state })}\n\n`);
        break;
      }
      idle = evs.length ? 0 : idle + 1;
      if (idle % 30 === 29) raw.write(": keepalive\n\n");
      await new Promise((res) => setTimeout(res, 300));
    }
    raw.end();
  });

  app.get(`${P}/runs/:id/diff`, async (req) => {
    const r = must(getRun(db, IdParam.parse(req.params).id), "Ejecución");
    const d = get<{ files: string; patch: string }>(db, "SELECT files, patch FROM run_diff WHERE run_id=?", r.id);
    if (!d) return ok({ files: [], patch: "", diffHash: r.diff_hash, warnings: [] }, req.id);
    const files = JSON.parse(d.files) as Array<{ path: string; status: string }>;
    const warnings: Array<{ type: string; message: string }> = [];
    if (containsSecret(d.patch)) warnings.push({ type: "secret", message: "El diff contiene valores con aspecto de secreto; se muestran redactados" });
    for (const f of files) if (isSensitivePath(f.path)) warnings.push({ type: "sensitive-path", message: `Archivo sensible modificado: ${f.path}` });
    const failed = all<{ command_id: string }>(db, "SELECT command_id FROM quality_check WHERE run_id=? AND state != 'PASSED'", r.id);
    for (const f of failed) warnings.push({ type: "check-failed", message: `Check no aprobado: ${f.command_id}` });
    return ok({ files, patch: redactSecrets(d.patch), diffHash: r.diff_hash, warnings }, req.id);
  });

  app.get(`${P}/runs/:id/checks`, async (req) => {
    const r = must(getRun(db, IdParam.parse(req.params).id), "Ejecución");
    return ok(all(db, "SELECT id, command_id AS commandId, exit_code AS exitCode, state, duration_ms AS durationMs, stdout, stderr, created_at AS createdAt FROM quality_check WHERE run_id=? ORDER BY created_at", r.id), req.id);
  });

  app.post(`${P}/runs/:id/review`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ decision: z.enum(["approve", "reject", "needs_changes"]), diffHash: z.string().min(8).max(128), reason: z.string().max(500).optional(), overrideQa: z.boolean().default(false) }).strict().parse(req.body);
    const r = must(getRun(db, id), "Ejecución");
    const t = getTask(db, r.task_id)!;
    const p = getProject(db, t.project_id)!;
    if (t.state !== "REVIEW_PENDING" || r.state !== "SUCCEEDED") throw new AppError("INVALID_STATE", "La ejecución no está pendiente de revisión");
    const actor = req.auth!.userId;
    const now = new Date();

    const record = (decision: Approval["decision"], reason: string | null, consumed: boolean) =>
      run(db, "INSERT INTO approval(id,run_id,action,diff_hash,expires_at,decision,consumed_at,actor_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        newId("apr"), id, "accept_diff", b.diffHash, new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(), decision, consumed ? now.toISOString() : null, actor, reason, now.toISOString());

    if (b.decision !== "approve") {
      tx(db, () => {
        record(b.decision === "reject" ? "REJECTED" : "REVOKED", b.reason ?? null, true);
        applyTaskTransition(db, t.id, b.decision === "reject" ? "REJECTED" : "NEEDS_CHANGES", actor, b.reason ?? null); // RN-009: la evidencia se conserva
        audit(db, { actorId: actor, action: `review.${b.decision}`, entityType: "run", entityId: id, outcome: "OK", detail: { reason: b.reason }, correlationId: req.id });
      });
      if (r.worktree_path) await removeWorktree(p.repo_path, r.worktree_path);
      return ok({ task: taskView(db, getTask(db, t.id)!), run: runView(getRun(db, id)!) }, req.id);
    }

    // Aprobación: revalidar el diff real ahora (TOCTOU, T-010) y ligarla al hash.
    if (!r.worktree_path || !r.base_commit) throw new AppError("INVALID_STATE", "No hay worktree para entregar");
    const snap = await snapshotDiff(r.worktree_path, r.base_commit);
    const approval: Approval = { id: newId("apr"), runId: id, action: "accept_diff", diffHash: b.diffHash, expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS), decision: "APPROVED", consumedAt: null };
    const v = validateApproval(approval, { runId: id, action: "accept_diff", currentDiffHash: snap.hash, now });
    if (!v.ok || r.diff_hash !== snap.hash) {
      record("REVOKED", `DIFF_CHANGED`, true);
      throw new AppError("INVALID_STATE", "El diff cambió desde que lo revisaste; revisalo de nuevo (aprobación invalidada)", true);
    }
    const states = all<{ state: CheckState }>(db, "SELECT state FROM quality_check WHERE run_id=?", id).map((c) => c.state);
    const qaOk = canMarkQaPassed(states);
    if (!qaOk && !(b.overrideQa && b.reason?.trim())) throw new AppError("INVALID_STATE", states.length === 0 ? "No hay evidencia de QA: aprobá con excepción explícita y motivo" : "Hay checks sin aprobar: aprobá con excepción explícita y motivo", true);
    const message = `DevPilot: ${t.title}\n\nRun ${id} (intento ${r.attempt}). Aprobado por el propietario.`;
    const sha = await commitAll(r.worktree_path, message);
    consumeApproval(approval, now);
    tx(db, () => {
      record("APPROVED", b.reason ?? null, true);
      run(db, "UPDATE run SET delivered_commit=? WHERE id=?", sha, id);
      applyTaskTransition(db, t.id, "APPROVED", actor, b.reason ?? "diff aprobado");
      audit(db, { actorId: actor, action: "review.approve", entityType: "run", entityId: id, outcome: "OK", detail: { diffHash: b.diffHash, commit: sha, qaOverride: !qaOk, reason: b.reason }, correlationId: req.id });
    });
    await removeWorktree(p.repo_path, r.worktree_path); // la rama queda; NO se hace merge, push ni deploy (RN-015)
    return ok({ task: taskView(db, getTask(db, t.id)!), run: runView(getRun(db, id)!), branch: r.branch, commit: sha }, req.id);
  });

  // ---------- Proveedores, auditoría, dashboard ----------
  app.get(`${P}/providers`, async (req) => {
    const out = [];
    for (const p of providers.values()) {
      const [c, h] = await Promise.all([p.capabilities(), p.health()]);
      out.push({ ...c, ...h });
    }
    const models = await listOllamaModels(config);
    out.push({ id: "ollama", costOrigin: "LOCAL", canWriteCode: false, available: models !== null && models.length > 0, detail: models ? `Modelos: ${models.join(", ") || "ninguno"}` : "No responde en " + config.ollamaBaseUrl, role: "classification" });
    return ok({ providers: out, paidApisEnabled: config.enablePaidApis }, req.id);
  });

  app.get(`${P}/audit`, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().positive().optional(), action: z.string().max(80).optional() }).parse(req.query);
    const rows = all<{ id: number }>(db, "SELECT id, actor_id AS actorId, action, entity_type AS entityType, entity_id AS entityId, outcome, detail, correlation_id AS correlationId, created_at AS createdAt FROM audit_event WHERE (? IS NULL OR id < ?) AND (? IS NULL OR action LIKE ?) ORDER BY id DESC LIMIT ?",
      q.before ?? null, q.before ?? null, q.action ?? null, q.action ? `${q.action}%` : null, q.limit);
    return ok(rows, req.id, { nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.id : null });
  });

  app.get(`${P}/dashboard`, async (req) => {
    const running = all(db, "SELECT r.id, r.state, r.provider_id AS providerId, r.started_at AS startedAt, t.title, t.id AS taskId FROM run r JOIN task t ON t.id=r.task_id WHERE r.state IN ('RUNNING','QUEUED') ORDER BY r.created_at");
    const needsApproval = all(db, "SELECT r.id, r.state, t.title, t.id AS taskId, 'start' AS kind FROM run r JOIN task t ON t.id=r.task_id WHERE r.state='PENDING_APPROVAL' UNION ALL SELECT r.id, r.state, t.title, t.id, 'review' FROM run r JOIN task t ON t.id=r.task_id WHERE t.state='REVIEW_PENDING' AND r.state='SUCCEEDED'");
    const failed = all(db, "SELECT r.id, r.state, r.error, r.finished_at AS finishedAt, t.title, t.id AS taskId FROM run r JOIN task t ON t.id=r.task_id WHERE r.state IN ('FAILED','TIMED_OUT','UNKNOWN','BLOCKED') ORDER BY r.created_at DESC LIMIT 10");
    const stats = get(db, "SELECT (SELECT COUNT(*) FROM project WHERE status='ACTIVE') AS projects, (SELECT COUNT(*) FROM task WHERE archived=0) AS tasks, (SELECT COUNT(*) FROM run) AS runs, (SELECT COUNT(*) FROM run WHERE state='SUCCEEDED') AS succeeded");
    return ok({ running, needsApproval, failed, stats }, req.id);
  });
}

export { mkdirSync };
