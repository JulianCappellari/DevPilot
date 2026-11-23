import { mkdirSync } from "node:fs";
import path from "node:path";
import { canUseProvider, deriveCheckState, isTerminalRun, type RunState, type TaskState } from "@devpilot/domain";
import type { AgentProvider, MarkdownEdit } from "@devpilot/providers";
import { addWorktree, cleanupDockerRun, DockerSandbox, dockerAvailable, headSha, removeWorktree, runCommand, snapshotDiff, type RunResult } from "@devpilot/runner";
import { resolveCheck, resolveInsideRoot } from "@devpilot/security";
import {
  all, appendRunEvent, applyRunTransition, applyTaskTransition, audit, get, getProject, getRun, getTask, newId, nowIso, run, tx,
  hasPendingPrerequisites,
  type Config, type DB,
} from "@devpilot/storage";

type JobLog = { runId: string; correlationId: string };
export type WorkerDeps = { db: DB; config: Config; providers: Map<string, AgentProvider>; log?: (msg: string, fields?: JobLog) => void };
function jobLog(db: DB, runId: string): JobLog {
  const event = get<{ correlation_id: string | null }>(db, "SELECT correlation_id FROM audit_event WHERE entity_type='run' AND entity_id=? AND action='run.approve_start' ORDER BY id DESC LIMIT 1", runId);
  return { runId, correlationId: event?.correlation_id ?? runId };
}

const LEASE_MS = 60_000;

/** Reclama un job con lease (cola durable sobre la BD, ADR-002). Un run RUNNING huérfano no se reanuda (RN-012). */
export function claimJob(db: DB, maxActive: number): { id: string; run_id: string } | undefined {
  return tx(db, () => {
    const active = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM run WHERE state = 'RUNNING'")?.n ?? 0;
    if (active >= maxActive) return undefined;
    const now = nowIso();
    const job = get<{ id: string; run_id: string }>(db,
      "SELECT id, run_id FROM job WHERE state = 'QUEUED' OR (state = 'LEASED' AND lease_until < ?) ORDER BY created_at LIMIT 1", now);
    if (!job) return undefined;
    run(db, "UPDATE job SET state='LEASED', lease_until=?, retry_count=retry_count+1 WHERE id=?", new Date(Date.now() + LEASE_MS).toISOString(), job.id);
    return job;
  });
}

const TASK_FOR_RUN: Partial<Record<RunState, TaskState>> = {
  SUCCEEDED: "REVIEW_PENDING", FAILED: "FAILED", PARTIAL: "FAILED", CANCELLED: "CANCELLED", TIMED_OUT: "TIMED_OUT", UNKNOWN: "UNKNOWN", BLOCKED: "CANCELLED",
};

function finishRun(deps: WorkerDeps, runId: string, state: RunState, error: string | null): void {
  const { db } = deps;
  tx(db, () => {
    const r = applyRunTransition(db, runId, state, { error, finished: true });
    const to = TASK_FOR_RUN[state];
    const task = getTask(db, r.task_id);
    if (to && task && (task.state === "RUNNING" || (task.state === "QUEUED" && to === "CANCELLED")))
      applyTaskTransition(db, task.id, to, null, `run ${state}`);
    run(db, "UPDATE job SET state='DONE', lease_until=NULL WHERE run_id=?", runId);
    appendRunEvent(db, runId, "run.completed", { state, error });
    audit(db, { actorId: null, action: "run.finished", entityType: "run", entityId: runId, outcome: state === "SUCCEEDED" ? "OK" : "FAILED", detail: { state, error },
      correlationId: jobLog(db, runId).correlationId });
  });
}

function recordCheck(db: DB, runId: string, id: string, res: RunResult, environment: string): void {
  const state = deriveCheckState({ exitCode: res.exitCode, timedOut: res.timedOut });
  const chkId = newId("chk");
  run(db, "INSERT INTO quality_check(id,run_id,command_id,exit_code,state,duration_ms,stdout,stderr,created_at,environment) VALUES(?,?,?,?,?,?,?,?,?,?)",
    chkId, runId, id, res.exitCode, state, res.durationMs, res.stdout, res.stderr, nowIso(), environment);
  appendRunEvent(db, runId, "run.check.finished", { checkId: chkId, commandId: id, state, exitCode: res.exitCode, durationMs: res.durationMs });
}

/** Al arrancar: runs RUNNING sin worker vivo pasan a UNKNOWN, nunca a éxito (CU-11, RNF-009). */
export function reconcileOrphans(deps: WorkerDeps): number {
  const { db } = deps;
  const orphans = all<{ id: string }>(db, "SELECT id FROM run WHERE state = 'RUNNING'");
  for (const o of orphans) {
    appendRunEvent(db, o.id, "run.state", { state: "UNKNOWN", message: "Reinicio detectado: estado no verificable" });
    finishRun(deps, o.id, "UNKNOWN", "Worker reiniciado durante la ejecución");
  }
  return orphans.length;
}

export async function processJob(deps: WorkerDeps, job: { id: string; run_id: string }): Promise<void> {
  const { db, config } = deps;
  const runId = job.run_id;
  const r0 = getRun(db, runId);
  if (!r0 || isTerminalRun(r0.state)) {
    run(db, "UPDATE job SET state='DONE', lease_until=NULL WHERE id=?", job.id);
    return;
  }
  if (r0.state !== "QUEUED") { // reclamado tras lease vencido con run no QUEUED: no se reanuda
    run(db, "UPDATE job SET state='DONE', lease_until=NULL WHERE id=?", job.id);
    return;
  }
  const task = getTask(db, r0.task_id)!;
  const project = getProject(db, task.project_id)!;

  if (r0.cancel_requested) { finishRun(deps, runId, "CANCELLED", "Cancelada antes de iniciar"); return; }

  const provider = deps.providers.get(r0.provider_id);
  const capabilities = await provider?.capabilities();
  if (getRun(db, runId)?.state !== "QUEUED") return;
  const origin = capabilities?.costOrigin ?? "LOCAL";
  const gate = canUseProvider(origin, r0.provider_id, { enablePaidApis: config.enablePaidApis, paidProviderConsent: new Set() });
  if (!provider || !gate.ok || (origin !== "LOCAL" && !r0.external_ack) ||
      (r0.cost_origin !== null && r0.cost_origin !== origin)) {
    finishRun(deps, runId, "BLOCKED", "Proveedor no permitido o falta el consentimiento para compartir contexto");
    return;
  }
  const health = await provider.health();
  if (getRun(db, runId)?.state !== "QUEUED") return;
  if (!health.available) {
    finishRun(deps, runId, "BLOCKED", health.detail ?? "Proveedor no disponible");
    return;
  }
  const enabled = JSON.parse(project.enabled_checks) as string[];
  const isolated = config.sandbox === "docker" && enabled.length > 0;
  const sandboxReady = !isolated || await dockerAvailable(process.cwd());
  if (getRun(db, runId)?.state !== "QUEUED") return;
  if (!sandboxReady) { finishRun(deps, runId, "BLOCKED", "Docker Linux no está disponible; los checks requieren el sandbox"); return; }
  const root = get<{ canonical_path: string }>(db, "SELECT canonical_path FROM allowed_root WHERE id=? AND enabled=1", project.root_id);
  const currentRepo = root && await resolveInsideRoot(root.canonical_path, project.repo_path).catch(() => null);
  if (getRun(db, runId)?.state !== "QUEUED") return;
  const latestProject = getProject(db, project.id);
  const latestTask = getTask(db, task.id);
  if (!currentRepo || path.relative(currentRepo, project.repo_path) || latestProject?.status !== "ACTIVE" ||
      (r0.requested_project_version !== null && latestProject.version !== r0.requested_project_version) ||
      !latestTask || latestTask.archived || hasPendingPrerequisites(db, task.id) ||
      (r0.requested_task_version !== null && latestTask.version !== r0.requested_task_version + 1)) {
    finishRun(deps, runId, "BLOCKED", "El proyecto ya no está activo o autorizado");
    return;
  }

  applyRunTransition(db, runId, "RUNNING", { started: true });
  applyTaskTransition(db, task.id, "RUNNING", null, "run iniciado");
  appendRunEvent(db, runId, "run.state", { state: "RUNNING", message: "Ejecución iniciada" });

  const ac = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; ac.abort(); }, config.runTimeoutMs);
  const poll = setInterval(() => {
    if (getRun(db, runId)?.cancel_requested) ac.abort();
  }, 250);
  const extendLease = setInterval(() => run(db, "UPDATE job SET lease_until=? WHERE id=?", new Date(Date.now() + LEASE_MS).toISOString(), job.id), LEASE_MS / 3);

  let worktree: string | null = null;
  let sandbox: DockerSandbox | undefined;
  try {
    const base = await headSha(project.repo_path);
    worktree = path.join(config.workspaceRoot, runId);
    const branch = `devpilot/${runId}`;
    mkdirSync(config.workspaceRoot, { recursive: true });
    await addWorktree(project.repo_path, worktree, branch, base);
    run(db, "UPDATE run SET worktree_path=?, branch=?, base_commit=? WHERE id=?", worktree, branch, base, runId);
    appendRunEvent(db, runId, "run.progress", { message: `Worktree creado en la rama ${branch}` });

    const criteria = all<{ text: string }>(db, "SELECT text FROM acceptance_criterion WHERE task_id=? ORDER BY position", task.id).map((c) => c.text);
    const contextRefs = all<{ path: string }>(db, "SELECT path FROM context_file WHERE project_id=? ORDER BY path LIMIT 20", project.id).map((file) => file.path);
    const markdownEdit = r0.provider_id === "context-markdown"
      ? get<MarkdownEdit>(db, "SELECT path,base_sha256 AS sha256,content FROM context_proposal WHERE task_id=?", task.id) : undefined;
    let failure: string | null = null;
    let completed = false;
    try {
      for await (const ev of provider.execute({
        runId, projectId: project.id, worktreePath: worktree, task: task.title, acceptanceCriteria: criteria,
        policy: { readOnly: !capabilities?.canWriteCode || r0.write_scope === 0, timeoutMs: config.runTimeoutMs }, contextRefs,
        ...(markdownEdit ? { markdownEdit } : {}),
      }, ac.signal)) {
        if (ev.type === "progress") appendRunEvent(db, runId, "run.progress", { message: ev.message });
        else if (ev.type === "file_changed") appendRunEvent(db, runId, "run.file_changed", { path: ev.path, change: ev.change });
        else if (ev.type === "message") appendRunEvent(db, runId, "run.log", { text: ev.text });
        else if (ev.type === "error") failure = ev.message;
        else if (ev.type === "completed") completed = true;
        // tool_request/tool_result: se registran como log; nunca se ejecutan como instrucciones (§8.4)
        else if (ev.type === "tool_request" || ev.type === "tool_result") appendRunEvent(db, runId, "run.log", { text: `${ev.type}: ${ev.tool}` });
        if (ac.signal.aborted) break;
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : "error de proveedor";
    }

    const cancelled = !!getRun(db, runId)?.cancel_requested;
    let final: RunState;
    if (timedOut) final = "TIMED_OUT";
    else if (cancelled) final = "CANCELLED";
    else if (failure || !completed) final = "FAILED";
    else final = "SUCCEEDED";

    if (final === "SUCCEEDED") {
      let checks = enabled;
      if (isolated) {
        sandbox = new DockerSandbox(worktree, runId, config.checkTimeoutMs, ac.signal, config.sandboxLimits);
        appendRunEvent(db, runId, "run.progress", { message: "Preparando dependencias en Docker" });
        const prepared = await sandbox.prepare();
        if (prepared.cancelled) final = timedOut ? "TIMED_OUT" : "CANCELLED";
        else if (prepared.exitCode === 125 || (prepared.exitCode === null && !prepared.timedOut)) {
          final = "BLOCKED";
          failure = "No se pudo iniciar el sandbox de Docker";
        }
        if (prepared.exitCode !== 0 || prepared.cancelled || prepared.timedOut) {
          recordCheck(db, runId, "dependencies", prepared, "Docker Linux · node:24-slim · instalación npm");
          checks = [];
        }
      }
      for (const id of checks) {
        let cmd;
        try { cmd = resolveCheck(id, enabled); }
        catch { continue; } // un id inválido en la configuración no se ejecuta jamás
        appendRunEvent(db, runId, "run.progress", { message: `Ejecutando check ${id}` });
        const res = sandbox ? await sandbox.check(id, cmd.file, cmd.args) :
          await runCommand({ file: cmd.file, args: cmd.args, cwd: worktree, timeoutMs: config.checkTimeoutMs, signal: ac.signal });
        recordCheck(db, runId, id, res, sandbox ? "Docker Linux · node:24-slim · sin red" : `Host · ${process.platform} ${process.arch} · Node ${process.version}`);
        if (res.cancelled) { final = timedOut ? "TIMED_OUT" : "CANCELLED"; break; }
        if (sandbox && (res.exitCode === 125 || (res.exitCode === null && !res.timedOut))) {
          final = "BLOCKED"; failure = "El sandbox de Docker dejó de estar disponible"; break;
        }
      }
    }

    // Evidencia de diff incluso en fallos/cancelaciones (RN-009)
    try {
      const snap = await snapshotDiff(worktree, base);
      run(db, "INSERT OR REPLACE INTO run_diff(run_id,files,patch,created_at) VALUES(?,?,?,?)", runId, JSON.stringify(snap.files), snap.patch, nowIso());
      run(db, "UPDATE run SET diff_hash=? WHERE id=?", snap.hash, runId);
      if (final === "FAILED" && snap.files.length > 0) final = "PARTIAL";
    } catch (e) {
      appendRunEvent(db, runId, "run.error", { message: "No se pudo capturar el diff: " + (e instanceof Error ? e.message : "") });
      if (final === "SUCCEEDED") { final = "FAILED"; failure = "No se pudo verificar el diff"; }
    }
    if (timedOut) final = "TIMED_OUT";
    else if (getRun(db, runId)?.cancel_requested) final = "CANCELLED";
    finishRun(deps, runId, final, final === "SUCCEEDED" ? null : failure ?? (final === "TIMED_OUT" ? "Tiempo máximo excedido" : final === "CANCELLED" ? "Cancelada por el usuario" : "El proveedor no completó"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    appendRunEvent(db, runId, "run.error", { message: msg });
    if (!isTerminalRun(getRun(db, runId)!.state)) finishRun(deps, runId, "FAILED", msg);
    if (worktree) await removeWorktree(project.repo_path, worktree);
  } finally {
    clearTimeout(timeout);
    clearInterval(poll);
    clearInterval(extendLease);
    await sandbox?.close();
  }
}

export type WorkerHandle = { stop(): Promise<void>; tick(): Promise<boolean> };

/** Bucle del worker: una ejecución escritora a la vez (RNF-015). */
export function startWorker(deps: WorkerDeps, intervalMs = 400): WorkerHandle {
  let stopped = false;
  let busy = false;
  const interrupted = deps.config.sandbox === "docker"
    ? all<{ id: string }>(deps.db, "SELECT id FROM run WHERE state='RUNNING'") : [];
  const cleanup = Promise.all(interrupted.map(({ id }) => cleanupDockerRun(id, process.cwd()))).then(() => undefined);
  let current: Promise<void> = cleanup;
  const reconciled = reconcileOrphans(deps);
  if (reconciled) deps.log?.(`worker: ${reconciled} ejecución(es) huérfana(s) marcadas UNKNOWN`);

  const tick = async (): Promise<boolean> => {
    await cleanup;
    if (busy || stopped) return false;
    const job = claimJob(deps.db, deps.config.maxActiveRuns);
    if (!job) return false;
    busy = true;
    const fields = jobLog(deps.db, job.run_id);
    deps.log?.("Ejecución reclamada", fields);
    current = processJob(deps, job).catch((e) => deps.log?.(`worker error: ${String(e)}`, fields)).finally(() => { busy = false; });
    await current;
    return true;
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  return {
    tick,
    async stop() { stopped = true; clearInterval(timer); await current; },
  };
}
