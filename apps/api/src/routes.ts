import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CreateTaskInputSchema, TaskLabelsSchema, formatSse, ok, parseEventCursor, type RunEventType } from "@devpilot/contracts";
import {
  TASK_STATES, canMarkQaPassed, canRequestExecution, canUseProvider, canTransitionTask, cancelRun, consumeApproval, isTerminalRun,
  validateApproval, type Approval, type CheckState, type TaskState,
} from "@devpilot/domain";
import { commitReviewedTree, dockerAvailable, gitStatus, removeWorktree, snapshotDiff, topLevel } from "@devpilot/runner";
import { ALLOWLISTED_CHECKS, containsSecret, isSensitivePath, redactSecrets, resolveInsideAnyRoot, resolveInsideRoot, PathPolicyError, type CheckId } from "@devpilot/security";
import {
  all, applyRunTransition, applyTaskTransition, audit, get, getProject, getRun, getTask, listRunEventsAfter, newId, nowIso, run, tx,
  dependencyReaches, hasPendingPrerequisites, taskPrerequisites,
  type DB, type ProjectRow, type RunRow, type TaskRow,
} from "@devpilot/storage";
import type { AppDeps } from "./app.js";
import { AppError } from "./errors.js";
import { classifyTask, listOllamaModels, summarizeLocally } from "./classify.js";
import { githubPublisher, readGithub } from "./github.js";
import { registerContextRoutes } from "./context.js";
import { registerManualReview } from "./manual-review.js";
import { registerReports } from "./report.js";

const IdParam = z.object({ id: z.string().min(1).max(64) });
const CHECKS = z.array(z.enum(Object.keys(ALLOWLISTED_CHECKS) as CheckId[])).max(Object.keys(ALLOWLISTED_CHECKS).length).transform((checks) => [...new Set(checks)]);
const VersionedPatch = z.object({ version: z.number().int().positive() });
const APPROVAL_TTL_MS = 5 * 60_000;

const parseCriteria = (db: DB, taskId: string) =>
  all<{ id: string; text: string; position: number }>(db, "SELECT id, text, position FROM acceptance_criterion WHERE task_id = ? ORDER BY position", taskId);

const taskView = (db: DB, t: TaskRow) => ({
  id: t.id, projectId: t.project_id, title: t.title, description: t.description, type: t.type, priority: t.priority, state: t.state,
  version: t.version, archived: !!t.archived, createdAt: t.created_at, updatedAt: t.updated_at,
  classification: t.classification ? JSON.parse(t.classification) : null,
  contextProposal: Boolean(get(db, "SELECT task_id FROM context_proposal WHERE task_id=?", t.id)),
  labels: all<{ label: string }>(db, "SELECT label FROM task_label WHERE task_id=? ORDER BY label", t.id).map((row) => row.label),
  acceptanceCriteria: parseCriteria(db, t.id).map((c) => c.text),
});

function replaceLabels(db: DB, id: string, labels: string[]) {
  run(db, "DELETE FROM task_label WHERE task_id=?", id);
  for (const label of labels) run(db, "INSERT INTO task_label(task_id,label) VALUES(?,?)", id, label);
}

const projectView = (db: DB, p: ProjectRow) => ({
  id: p.id, name: p.name, status: p.status, version: p.version, enabledChecks: JSON.parse(p.enabled_checks) as string[],
  rootId: p.root_id, path: p.repo_path, createdAt: p.created_at,
  logicalPath: path.relative(get<{ canonical_path: string }>(db, "SELECT canonical_path FROM allowed_root WHERE id=?", p.root_id)!.canonical_path, p.repo_path).split(path.sep).join("/") || ".",
});

const runView = (r: RunRow) => ({
  id: r.id, taskId: r.task_id, providerId: r.provider_id, state: r.state, attempt: r.attempt, branch: r.branch, baseCommit: r.base_commit,
  diffHash: r.diff_hash, deliveredCommit: r.delivered_commit, error: r.error, cancelRequested: !!r.cancel_requested,
  costOrigin: r.cost_origin, canWriteCode: r.write_scope === null ? null : Boolean(r.write_scope),
  createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, version: r.version,
});

export function registerDomainRoutes(app: FastifyInstance, deps: AppDeps, P: string): void {
  const { db, config, providers } = deps;
  const must = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new AppError("NOT_FOUND", `${what} no encontrado`); return v; };
  const prPublisher = deps.prPublisher ?? githubPublisher;
  const publishing = new Set<string>();
  const reviewing = new Set<string>();
  const prFor = (id: string) => get<{ number: number; url: string }>(db, "SELECT number,url FROM pull_request WHERE run_id=?", id);

  async function authorizedRepo(project: ProjectRow): Promise<string> {
    const root = get<{ canonical_path: string }>(db, "SELECT canonical_path FROM allowed_root WHERE id=? AND enabled=1", project.root_id);
    if (!root || project.status !== "ACTIVE") throw new AppError("FORBIDDEN", "El proyecto no está activo o autorizado", true);
    return resolveInsideRoot(root.canonical_path, project.repo_path);
  }
  registerContextRoutes(app, deps, P, authorizedRepo);
  registerManualReview(app, db, P);
  registerReports(app, db, P);

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
      ...projectView(db, p),
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
    return ok(projectView(db, getProject(db, id)!), req.id);
  });

  app.get(`${P}/projects/:id`, async (req) => ok({
    ...projectView(db, must(getProject(db, IdParam.parse(req.params).id), "Proyecto")), githubReadEnabled: config.githubReadEnabled,
  }, req.id));

  app.get(`${P}/projects/:id/github`, async (req) => {
    if (!config.githubReadEnabled) throw new AppError("FORBIDDEN", "La consulta de GitHub está deshabilitada", true);
    const { id } = IdParam.parse(req.params);
    const query = z.object({
      kind: z.enum(["issues", "pulls"]).default("issues"),
      page: z.coerce.number().int().min(1).max(100).default(1),
      state: z.enum(["open", "closed", "all"]).default("open"),
    }).strict().parse(req.query);
    const repo = await authorizedRepo(must(getProject(db, id), "Proyecto"));
    let target;
    try { target = await prPublisher.destination(repo); }
    catch { throw new AppError("INVALID_STATE", "El proyecto necesita un origin único de github.com"); }
    const result = await (deps.githubReader ?? readGithub)(repo, target.slug, query.kind, query.page, query.state);
    return ok({ ...result, repo: target.slug, page: query.page }, req.id);
  });

  app.patch(`${P}/projects/:id`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = VersionedPatch.extend({ name: z.string().trim().min(1).max(100).optional(), status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional(), enabledChecks: CHECKS.optional() }).strict().parse(req.body);
    const p = must(getProject(db, id), "Proyecto");
    const r = run(db, "UPDATE project SET name=?, status=?, enabled_checks=?, version=version+1, updated_at=? WHERE id=? AND version=?",
      b.name ?? p.name, b.status ?? p.status, JSON.stringify(b.enabledChecks ?? JSON.parse(p.enabled_checks)), nowIso(), id, b.version);
    if (r.changes !== 1) throw new AppError("VERSION_CONFLICT", "El proyecto cambió; recargá y reintentá");
    audit(db, { actorId: req.auth!.userId, action: "project.update", entityType: "project", entityId: id, outcome: "OK", detail: { status: b.status, checks: b.enabledChecks }, correlationId: req.id });
    return ok(projectView(db, getProject(db, id)!), req.id);
  });

  app.get(`${P}/projects/:id/git`, async (req) => {
    const p = must(getProject(db, IdParam.parse(req.params).id), "Proyecto");
    // Revalida la ruta contra los roots antes de tocar el FS (TOCTOU, RN-016).
    await resolveInsideAnyRoot(enabledRoots().map((r) => r.canonical_path), p.repo_path);
    return ok(await gitStatus(p.repo_path), req.id);
  });

  app.get(`${P}/projects/:id/tasks`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const q = z.object({ state: z.enum(TASK_STATES).optional(), q: z.string().max(100).optional(), label: z.string().trim().max(30).optional(), archived: z.enum(["true", "false"]).default("false"), sort: z.enum(["priority", "updated", "created"]).default("updated") }).parse(req.query);
    must(getProject(db, id), "Proyecto");
    const order = q.sort === "priority" ? "CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC" : q.sort === "created" ? "created_at DESC" : "updated_at DESC";
    const label = q.label?.toLowerCase() || null;
    const rows = all<TaskRow>(db, `SELECT * FROM task WHERE project_id=? AND archived=? AND (? IS NULL OR state=?) AND (? IS NULL OR title LIKE ? ESCAPE '\\')
      AND (? IS NULL OR EXISTS (SELECT 1 FROM task_label l WHERE l.task_id=task.id AND l.label=?)) ORDER BY ${order} LIMIT 500`,
      id, q.archived === "true" ? 1 : 0, q.state ?? null, q.state ?? null, q.q ?? null, q.q ? `%${q.q.replace(/[\\%_]/g, "\\$&")}%` : null, label, label);
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
      replaceLabels(db, id, b.labels);
      run(db, "INSERT INTO task_history(task_id,from_state,to_state,actor_id,reason,created_at) VALUES(?,?,?,?,?,?)", id, null, state, req.auth!.userId, "creación", now);
      audit(db, { actorId: req.auth!.userId, action: "task.create", entityType: "task", entityId: id, outcome: "OK", correlationId: req.id });
    });
    return ok(taskView(db, getTask(db, id)!), req.id);
  });

  app.get(`${P}/tasks/:id`, async (req) => {
    const t = must(getTask(db, IdParam.parse(req.params).id), "Tarea");
    const history = all(db, "SELECT from_state AS \"from\", to_state AS \"to\", actor_id AS actorId, reason, created_at AS at FROM task_history WHERE task_id=? ORDER BY id", t.id);
    const runs = all<RunRow>(db, "SELECT * FROM run WHERE task_id=? ORDER BY attempt DESC", t.id).map(runView);
    return ok({ ...taskView(db, t), history, runs, prerequisites: taskPrerequisites(db, t.id), project: projectView(db, getProject(db, t.project_id)!) }, req.id);
  });

  app.patch(`${P}/tasks/:id`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = VersionedPatch.extend({
      title: z.string().trim().min(3).max(200).optional(), description: z.string().max(10_000).nullable().optional(),
      type: CreateTaskInputSchema.shape.type.optional(), priority: CreateTaskInputSchema.shape.priority.optional(),
      acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
      labels: TaskLabelsSchema.optional(),
      prerequisiteIds: z.array(z.string().min(1).max(64)).max(20).optional(),
    }).strict().parse(req.body);
    const t = must(getTask(db, id), "Tarea");
    if (!["DRAFT", "READY", "NEEDS_CHANGES", "FAILED", "CANCELLED", "TIMED_OUT", "UNKNOWN"].includes(t.state)) throw new AppError("INVALID_STATE", `No se puede editar una tarea en estado ${t.state}`);
    tx(db, () => {
      if (b.prerequisiteIds) {
        const prerequisites = new Set(b.prerequisiteIds);
        for (const prerequisiteId of prerequisites) {
          const prerequisite = getTask(db, prerequisiteId);
          if (!prerequisite || prerequisite.project_id !== t.project_id || (prerequisite.archived && prerequisite.state !== "APPROVED"))
            throw new AppError("VALIDATION", "Elegí dependencias vigentes del mismo proyecto");
          if (dependencyReaches(db, prerequisiteId, id)) throw new AppError("INVALID_STATE", "La dependencia crearía un ciclo");
        }
        run(db, "DELETE FROM task_dependency WHERE task_id=?", id);
        for (const prerequisiteId of prerequisites) run(db, "INSERT INTO task_dependency(task_id,prerequisite_id) VALUES(?,?)", id, prerequisiteId);
      }
      const r = run(db, "UPDATE task SET title=?, description=?, type=?, priority=?, version=version+1, updated_at=? WHERE id=? AND version=?",
        b.title ?? t.title, b.description === undefined ? t.description : b.description, b.type ?? t.type, b.priority ?? t.priority, nowIso(), id, b.version);
      if (r.changes !== 1) throw new AppError("VERSION_CONFLICT", "La tarea cambió; recargá y reintentá");
      if (b.acceptanceCriteria) {
        run(db, "DELETE FROM acceptance_criterion WHERE task_id=?", id);
        b.acceptanceCriteria.forEach((x, i) => run(db, "INSERT INTO acceptance_criterion(id,task_id,text,position) VALUES(?,?,?,?)", newId("ac"), id, x, i));
      }
      if (b.labels) replaceLabels(db, id, b.labels);
      audit(db, { actorId: req.auth!.userId, action: "task.update", entityType: "task", entityId: id, outcome: "OK", detail: { prerequisiteIds: b.prerequisiteIds }, correlationId: req.id });
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
    if (t.state !== "APPROVED" && get(db, "SELECT 1 FROM task_dependency WHERE prerequisite_id=? LIMIT 1", id))
      throw new AppError("INVALID_STATE", "Quitá esta dependencia de las tareas que la requieren antes de archivarla");
    run(db, "UPDATE task SET archived=1, version=version+1, updated_at=? WHERE id=?", nowIso(), id);
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
  app.post(`${P}/tasks/:id/runs`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const { providerId, acknowledgeExternal } = z.object({ providerId: z.string().min(1).max(50), acknowledgeExternal: z.boolean().default(false) }).strict().parse(req.body);
    const t = must(getTask(db, id), "Tarea");
    const p = must(getProject(db, t.project_id), "Proyecto");
    if (t.state !== "READY" || t.archived) throw new AppError("INVALID_STATE", "La tarea debe estar lista y vigente");
    if (hasPendingPrerequisites(db, id)) throw new AppError("INVALID_STATE", "Aprobá las tareas requeridas antes de ejecutar esta tarea");
    const isMarkdown = Boolean(get(db, "SELECT task_id FROM context_proposal WHERE task_id=?", id));
    if ((providerId === "context-markdown") !== isMarkdown) throw new AppError("INVALID_STATE", "La propuesta Markdown requiere el proveedor de contexto");
    const policy = canRequestExecution({ projectStatus: p.status, acceptanceCriteria: parseCriteria(db, id).map((c) => c.text), scopeDefined: !!(t.description?.trim() || parseCriteria(db, id).length) });
    if (!policy.ok) throw new AppError("INVALID_STATE", policy.reason);
    const capabilities = await must(providers.get(providerId), "Proveedor").capabilities();
    const origin = capabilities.costOrigin;
    const gate = canUseProvider(origin, providerId, { enablePaidApis: config.enablePaidApis, paidProviderConsent: new Set() });
    if (!gate.ok) throw new AppError("FORBIDDEN", gate.reason, true);
    if (origin !== "LOCAL" && !acknowledgeExternal)
      throw new AppError("FORBIDDEN", "Confirmá que el contexto puede salir de tu equipo", true);
    const active = get(db, "SELECT id FROM run WHERE task_id=? AND state IN ('PENDING_APPROVAL','QUEUED','RUNNING')", id);
    if (active) throw new AppError("INVALID_STATE", "La tarea ya tiene una ejecución activa");
    const attempt = (get<{ m: number | null }>(db, "SELECT MAX(attempt) m FROM run WHERE task_id=?", id)?.m ?? 0) + 1;
    const runId = newId("run");
    run(db, "INSERT INTO run(id,task_id,provider_id,state,attempt,version,created_at,external_ack,requested_task_version,requested_project_version,write_scope,cost_origin) VALUES(?,?,?,'PENDING_APPROVAL',?,1,?,?,?,?,?,?)",
      runId, id, providerId, attempt, nowIso(), origin !== "LOCAL" && acknowledgeExternal ? 1 : 0, t.version, p.version, capabilities.canWriteCode ? 1 : 0, origin);
    audit(db, { actorId: req.auth!.userId, action: "run.request", entityType: "run", entityId: runId, outcome: "OK", detail: { providerId, origin, acknowledgeExternal }, correlationId: req.id });
    return ok(runView(getRun(db, runId)!), req.id);
  });

  app.get(`${P}/runs/:id`, async (req) => {
    const r = must(getRun(db, IdParam.parse(req.params).id), "Ejecución");
    const t = getTask(db, r.task_id)!;
    const checks = all(db, "SELECT id, command_id AS commandId, exit_code AS exitCode, state, duration_ms AS durationMs, environment, created_at AS createdAt FROM quality_check WHERE run_id=? ORDER BY created_at", r.id);
    const approvals = all(db, "SELECT id, action, decision, diff_hash AS diffHash, expires_at AS expiresAt, reason, created_at AS createdAt FROM approval WHERE run_id=? ORDER BY created_at", r.id);
    return ok({ ...runView(r), task: { id: t.id, title: t.title, state: t.state, version: t.version, projectId: t.project_id }, checks, approvals,
      pullRequest: prFor(r.id) ?? null, githubPrEnabled: config.githubPrEnabled }, req.id);
  });

  app.post(`${P}/runs/:id/approve-start`, async (req) => {
    const { id } = IdParam.parse(req.params);
    const r = must(getRun(db, id), "Ejecución");
    if (r.state !== "PENDING_APPROVAL") throw new AppError("INVALID_STATE", `La ejecución está ${r.state}`);
    const t = getTask(db, r.task_id)!;
    const p = getProject(db, t.project_id)!;
    if (p.status !== "ACTIVE") throw new AppError("INVALID_STATE", "El proyecto no está activo (RN-002)");
    if (t.archived || hasPendingPrerequisites(db, t.id)) throw new AppError("INVALID_STATE", "La tarea está archivada o tiene dependencias pendientes");
    if (r.requested_task_version !== t.version || r.requested_project_version !== p.version)
      throw new AppError("VERSION_CONFLICT", "Cambió la tarea o el proyecto. Cancelá esta solicitud y creá otra");
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
    raw.once("close", () => { closed = true; });
    let idle = 0;
    while (!closed) {
      const evs = listRunEventsAfter(db, r.id, cursor);
      for (const e of evs) {
        raw.write(formatSse(e.type as RunEventType, r.id, e.seq, { ...JSON.parse(e.payload), at: e.created_at }));
        cursor = e.seq;
      }
      const cur = getRun(db, r.id)!;
      if (evs.length === 0 && (isTerminalRun(cur.state) || cur.state === "UNKNOWN")) {
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
    if (containsSecret(d.patch) || d.patch.includes("[REDACTED]")) warnings.push({ type: "secret", message: "El diff contiene valores con aspecto de secreto; se muestran redactados" });
    const sensitive = files.some((file) => isSensitivePath(file.path));
    if (sensitive) warnings.push({ type: "sensitive-path", message: "La ejecución modificó un archivo sensible. El contenido se oculta y la entrega queda bloqueada." });
    const failed = all<{ command_id: string }>(db, "SELECT command_id FROM quality_check WHERE run_id=? AND state != 'PASSED'", r.id);
    for (const f of failed) warnings.push({ type: "check-failed", message: `Check no aprobado: ${f.command_id}` });
    return ok({ files: files.map((file) => ({ ...file, path: isSensitivePath(file.path) ? "[archivo sensible]" : redactSecrets(file.path) })),
      patch: sensitive ? "" : redactSecrets(d.patch), diffHash: r.diff_hash, warnings }, req.id);
  });

  app.get(`${P}/runs/:id/checks`, async (req) => {
    const r = must(getRun(db, IdParam.parse(req.params).id), "Ejecución");
    return ok(all(db, "SELECT id, command_id AS commandId, exit_code AS exitCode, state, duration_ms AS durationMs, stdout, stderr, environment, created_at AS createdAt FROM quality_check WHERE run_id=? ORDER BY created_at", r.id), req.id);
  });

  app.post(`${P}/runs/:id/summary`, async (req) => {
    const r = must(getRun(db, IdParam.parse(req.params).id), "Ejecución");
    const diff = must(get<{ files: string; patch: string }>(db, "SELECT files,patch FROM run_diff WHERE run_id=?", r.id), "Diff");
    const files = JSON.parse(diff.files) as { path: string }[];
    const checks = all<{ state: string; count: number }>(db, "SELECT state,COUNT(*) AS count FROM quality_check WHERE run_id=? GROUP BY state", r.id);
    const includePatch = !files.some((file) => isSensitivePath(file.path));
    const summary = await summarizeLocally(`Archivos modificados: ${files.length}\nChecks: ${JSON.stringify(checks)}\n${includePatch ? diff.patch : ""}`, config);
    const fallback = { decisions: [`${files.length} archivo(s) en el diff.`],
      pending: checks.filter((check) => check.state !== "PASSED").map((check) => `${check.count} check(s) con estado ${check.state}.`) };
    return ok({ ...(summary ?? fallback), source: summary ? "ollama" : "evidence", proposal: Boolean(summary) }, req.id);
  });

  app.post(`${P}/runs/:id/review`, async (req) => {
    const { id } = IdParam.parse(req.params);
    if (reviewing.has(id)) throw new AppError("VERSION_CONFLICT", "Ya hay una revisión en curso");
    reviewing.add(id);
    try { return await review(id, req); } finally { reviewing.delete(id); }
  });

  async function review(id: string, req: FastifyRequest) {
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
    if (!r.worktree_path || !r.base_commit || !r.branch) throw new AppError("INVALID_STATE", "No hay worktree para entregar");
    const snap = await snapshotDiff(r.worktree_path, r.base_commit).catch(() => {
      throw new AppError("INVALID_STATE", "No se pudo verificar el diff completo");
    });
    if (snap.files.some((file) => isSensitivePath(file.path)) || snap.patch.includes("[REDACTED]"))
      throw new AppError("FORBIDDEN", "Corregí los cambios sensibles antes de entregar la rama", true);
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
    if (getTask(db, t.id)?.state !== "REVIEW_PENDING") throw new AppError("VERSION_CONFLICT", "La revisión ya fue resuelta");
    const sha = await commitReviewedTree(r.worktree_path, r.branch, r.base_commit, snap.tree, message);
    consumeApproval(approval, now);
    tx(db, () => {
      record("APPROVED", b.reason ?? null, true);
      run(db, "UPDATE run SET delivered_commit=? WHERE id=?", sha, id);
      applyTaskTransition(db, t.id, "APPROVED", actor, b.reason ?? "diff aprobado");
      audit(db, { actorId: actor, action: "review.approve", entityType: "run", entityId: id, outcome: "OK", detail: { diffHash: b.diffHash, commit: sha, qaOverride: !qaOk, reason: b.reason }, correlationId: req.id });
    });
    await removeWorktree(p.repo_path, r.worktree_path); // la rama queda; NO se hace merge, push ni deploy (RN-015)
    return ok({ task: taskView(db, getTask(db, t.id)!), run: runView(getRun(db, id)!), branch: r.branch, commit: sha }, req.id);
  }

  async function prInput(id: string) {
    if (!config.githubPrEnabled) throw new AppError("FORBIDDEN", "La publicación en GitHub está deshabilitada", true);
    const r = must(getRun(db, id), "Ejecución");
    const t = must(getTask(db, r.task_id), "Tarea");
    if (r.state !== "SUCCEEDED" || !r.delivered_commit || r.branch !== `devpilot/${r.id}`)
      throw new AppError("INVALID_STATE", "Se requiere un commit revisado y entregado");
    const diff = get<{ files: string; patch: string }>(db, "SELECT files,patch FROM run_diff WHERE run_id=?", id);
    if (!diff || diff.patch.includes("[REDACTED]") || (JSON.parse(diff.files) as Array<{ path: string }>).some((file) => isSensitivePath(file.path)))
      throw new AppError("FORBIDDEN", "El diff requiere revisión local por posibles datos sensibles", true);
    const repo = await authorizedRepo(must(getProject(db, t.project_id), "Proyecto"));
    try {
      return { repo, target: await prPublisher.destination(repo), title: t.title, sha: r.delivered_commit };
    } catch (error) {
      throw new AppError("INVALID_STATE", error instanceof Error ? error.message : "Origin de GitHub inválido");
    }
  }

  app.get(`${P}/runs/:id/pr-target`, async (req) => {
    const id = IdParam.parse(req.params).id;
    const { target, sha } = await prInput(id);
    return ok({ repository: target.slug, commit: sha }, req.id);
  });

  app.post(`${P}/runs/:id/pr-approval`, async (req) => {
    const id = IdParam.parse(req.params).id;
    const expected = z.object({ repository: z.string().max(140), commit: z.string().min(40).max(64) }).strict().parse(req.body);
    const { target, sha } = await prInput(id);
    if (expected.repository !== target.slug || expected.commit !== sha) throw new AppError("VERSION_CONFLICT", "El destino o commit cambió");
    const actor = req.auth!.userId;
    const approvalId = newId("apr");
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
    tx(db, () => {
      run(db, "UPDATE approval SET decision='REVOKED' WHERE action='create_pr' AND run_id=? AND consumed_at IS NULL", id);
      run(db, "INSERT INTO approval(id,run_id,action,diff_hash,expires_at,decision,actor_id,reason,created_at) VALUES(?,?,'create_pr',?,?,'APPROVED',?,?,?)",
        approvalId, id, sha, expiresAt, actor, target.slug, nowIso());
      audit(db, { actorId: actor, action: "github.pr_approved", entityType: "run", entityId: id, outcome: "OK", detail: { commit: sha, repository: target.slug }, correlationId: req.id });
    });
    return ok({ approvalId, expiresAt }, req.id);
  });

  app.post(`${P}/runs/:id/pr`, async (req) => {
    const id = IdParam.parse(req.params).id;
    const { approvalId } = z.object({ approvalId: z.string().min(1).max(64) }).strict().parse(req.body);
    const { repo, target, sha, title } = await prInput(id);
    const actor = req.auth!.userId;
    const previous = prFor(id);
    if (previous) return ok(previous, req.id);
    if (publishing.has(id)) throw new AppError("VERSION_CONFLICT", "Ya hay una publicación en curso");
    const now = nowIso();
    const claimed = run(db, "UPDATE approval SET consumed_at=? WHERE id=? AND run_id=? AND action='create_pr' AND decision='APPROVED' AND consumed_at IS NULL AND expires_at>? AND actor_id=? AND diff_hash=? AND reason=?",
      now, approvalId, id, now, actor, sha, target.slug);
    if (!claimed.changes) throw new AppError("FORBIDDEN", "Se requiere una aprobación de PR vigente para el commit y destino actuales", true);
    publishing.add(id);
    try {
      const pr = await prPublisher.publish(repo, target, id, sha, title);
      tx(db, () => {
        run(db, "INSERT INTO pull_request(run_id,commit_sha,url,number,created_at) VALUES(?,?,?,?,?)", id, sha, pr.url, pr.number, nowIso());
        audit(db, { actorId: actor, action: "github.pr_created", entityType: "run", entityId: id, outcome: "OK", detail: { commit: sha, repository: target.slug, number: pr.number }, correlationId: req.id });
      });
      return ok(pr, req.id);
    } catch (error) {
      audit(db, { actorId: actor, action: "github.pr_failed", entityType: "run", entityId: id, outcome: "FAILED", detail: { commit: sha, repository: target.slug }, correlationId: req.id });
      throw error;
    } finally { publishing.delete(id); }
  });

  app.get(`${P}/metrics`, async (req) => ok({
    runs: all(db, "SELECT state, COUNT(*) AS count FROM run GROUP BY state"),
    jobs: all(db, "SELECT state, COUNT(*) AS count FROM job GROUP BY state"),
    checks: all(db, "SELECT state, COUNT(*) AS count, ROUND(AVG(duration_ms)) AS averageMs FROM quality_check GROUP BY state"),
  }, req.id));

  // ---------- Proveedores, auditoría, dashboard ----------
  app.get(`${P}/providers`, async (req) => {
    const out = [];
    const sandboxStatus = config.sandbox === "docker" ? dockerAvailable(process.cwd()) : Promise.resolve(false);
    const entries = await Promise.all([...providers.values()].map(async (p) => {
      const [c, h] = await Promise.all([p.capabilities(), p.health()]);
      return { ...c, ...h, adapterVersion: 1 };
    }));
    out.push(...entries);
    const models = await listOllamaModels(config);
    out.push({ id: "ollama", costOrigin: "LOCAL", canWriteCode: false, available: models !== null && models.length > 0, detail: models ? `Modelos: ${models.join(", ") || "ninguno"}` : "No responde en " + config.ollamaBaseUrl, role: "classification" });
    return ok({ providers: out, paidApisEnabled: config.enablePaidApis, sandbox: { mode: config.sandbox, available: await sandboxStatus } }, req.id);
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
