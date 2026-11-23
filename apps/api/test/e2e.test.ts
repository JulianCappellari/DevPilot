import { mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { defaultProviders, type AgentEvent, type AgentProvider } from "@devpilot/providers";
import { runCommand } from "@devpilot/runner";
import { all, get, loadConfig, newId, nowIso, openDb, run, type Config, type DB } from "@devpilot/storage";
import { startWorker, reconcileOrphans } from "../../worker/src/worker.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createDemoRepo, seedRoots } from "../src/seed.js";

const PW = "correct-horse-battery";
let base: string, config: Config, db: DB, app: FastifyInstance, providers: Map<string, AgentProvider>;
let repo: string, cookie = "", csrf = "";

type Res = { status: number; body: any };
async function call(method: string, url: string, body?: unknown, opts: { auth?: boolean; csrf?: boolean; origin?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) headers["cookie"] = cookie;
  if (opts.csrf !== false && opts.auth !== false && method !== "GET") headers["x-csrf-token"] = csrf;
  if (opts.origin) headers["origin"] = opts.origin;
  const r = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

class SlowProvider implements AgentProvider {
  readonly id = "slow";
  capabilities() { return Promise.resolve({ id: "slow", costOrigin: "LOCAL" as const, canWriteCode: false }); }
  health() { return Promise.resolve({ available: true }); }
  async *execute(_r: unknown, signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "started", runId: "x" };
    while (!signal.aborted) await new Promise((r) => setTimeout(r, 30));
    yield { type: "error", message: "aborted" };
  }
}

async function newRun(providerId: string, title = "Corregir redirección post-login"): Promise<{ taskId: string; runId: string }> {
  const t = await call("POST", "/tasks", { projectId: projectId, title, type: "bug", priority: "medium", acceptanceCriteria: ["Usuario autenticado navega a /dashboard"] });
  expect(t.status).toBe(200);
  const r = await call("POST", `/tasks/${t.body.data.id}/runs`, { providerId });
  expect(r.status).toBe(200);
  return { taskId: t.body.data.id, runId: r.body.data.id };
}
let projectId = "";
const startAndRun = async (runId: string, w: { tick(): Promise<boolean> }) => {
  expect((await call("POST", `/runs/${runId}/approve-start`)).status).toBe(200);
  expect(await w.tick()).toBe(true);
};

beforeAll(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dp-e2e-")));
  config = loadConfig({ DATA_DIR: path.join(base, "data"), PROJECT_ROOTS: path.join(base, "projects"), OLLAMA_BASE_URL: "http://127.0.0.1:1" }, base);
  db = openDb(config.dbFile);
  providers = defaultProviders();
  providers.set("slow", new SlowProvider());
  run(db, "INSERT INTO user(id,username,password_hash,created_at) VALUES(?,?,?,?)", newId("usr"), "owner", hashPassword(PW), nowIso());
  repo = await createDemoRepo(path.join(base, "projects"));
  seedRoots(db, { ...config, projectRoots: [path.join(base, "projects")] });
  app = buildApp({ db, config, providers });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: PW } });
  expect(login.statusCode).toBe(200);
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  csrf = JSON.parse(login.body).data.csrfToken;
  const p = await call("POST", "/projects", { name: "demo-app", repoPath: repo, enabledChecks: ["lint", "test", "typecheck"] });
  expect(p.status).toBe(200);
  projectId = p.body.data.id;
});
afterAll(async () => {
  await app.close();
  db.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

describe("flujo completo de punta a punta", () => {
  it("proyecto -> tarea -> run -> checks reales -> diff -> aprobación -> rama entregada, sin merge", async () => {
    const w = startWorker({ db, config, providers }, 60_000);
    const mainBefore = (await runCommand({ file: "git", args: ["rev-parse", "main"], cwd: repo, timeoutMs: 10_000 })).stdout.trim();
    const { taskId, runId } = await newRun("mock-writer");
    await startAndRun(runId, w);

    const r = (await call("GET", `/runs/${runId}`)).body.data;
    expect(r.state).toBe("SUCCEEDED");
    expect(r.task.state).toBe("REVIEW_PENDING");
    expect(r.checks.map((c: any) => [c.commandId, c.state, c.exitCode])).toEqual([["lint", "PASSED", 0], ["test", "PASSED", 0], ["typecheck", "PASSED", 0]]);

    const diff = (await call("GET", `/runs/${runId}/diff`)).body.data;
    expect(diff.files).toEqual([{ path: `devpilot-notes/${runId}.md`, status: "added" }]);
    expect(diff.patch).toContain("Corregir redirección post-login");

    const rv = await call("POST", `/runs/${runId}/review`, { decision: "approve", diffHash: diff.diffHash });
    expect(rv.status).toBe(200);
    expect(rv.body.data.task.state).toBe("APPROVED");
    const branchHead = (await runCommand({ file: "git", args: ["rev-parse", rv.body.data.branch], cwd: repo, timeoutMs: 10_000 })).stdout.trim();
    expect(branchHead).toBe(rv.body.data.commit);
    // RN-015: main no se tocó
    expect((await runCommand({ file: "git", args: ["rev-parse", "main"], cwd: repo, timeoutMs: 10_000 })).stdout.trim()).toBe(mainBefore);

    // eventos persistidos con seq monótono y SSE reanudable
    const evs = all<{ seq: number }>(db, "SELECT seq FROM run_event WHERE run_id=? ORDER BY seq", runId);
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1));
    const sse = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events`, headers: { cookie, "last-event-id": `${runId}:${evs.length - 2}` } });
    expect(sse.body).toContain(`id: ${runId}:${evs.length}`);
    expect(sse.body).not.toContain(`id: ${runId}:1\n`);
    expect(sse.body).toContain("event: run.end");

    // una aprobación no se puede reutilizar: la tarea ya no está en revisión
    expect((await call("POST", `/runs/${runId}/review`, { decision: "approve", diffHash: diff.diffHash })).status).toBe(422);
    void taskId;
    await w.stop();
  });

  it("T-010: si el diff cambia tras revisarlo, la aprobación se invalida", async () => {
    const w = startWorker({ db, config, providers }, 60_000);
    const { runId } = await newRun("mock-writer", "Tarea con diff mutable");
    await startAndRun(runId, w);
    const diff = (await call("GET", `/runs/${runId}/diff`)).body.data;
    const wt = get<{ worktree_path: string }>(db, "SELECT worktree_path FROM run WHERE id=?", runId)!.worktree_path;
    appendFileSync(path.join(wt, "devpilot-notes", `${runId}.md`), "\nLINEA INYECTADA DESPUES DE LA REVISION\n");
    const rv = await call("POST", `/runs/${runId}/review`, { decision: "approve", diffHash: diff.diffHash });
    expect(rv.status).toBe(422);
    expect(rv.body.error.message).toMatch(/diff cambió/);
    expect(get<{ state: string }>(db, "SELECT state FROM task WHERE id=(SELECT task_id FROM run WHERE id=?)", runId)!.state).toBe("REVIEW_PENDING");
    expect(all(db, "SELECT id FROM audit_event WHERE outcome='DENIED' AND entity_id=?", runId).length).toBeGreaterThanOrEqual(1);
    await w.stop();
  });

  it("T-009: un check con exit 1 es FAIL y bloquea la autoaprobación salvo excepción con motivo", async () => {
    writeFileSync(path.join(repo, "scripts", "check.js"), "console.log('boom'); process.exit(process.argv[2]==='test'?1:0);\n");
    await runCommand({ file: "git", args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-am", "test falla"], cwd: repo, timeoutMs: 10_000 });
    const w = startWorker({ db, config, providers }, 60_000);
    const { runId } = await newRun("mock-writer", "Tarea con test fallido");
    await startAndRun(runId, w);
    const r = (await call("GET", `/runs/${runId}`)).body.data;
    expect(r.checks.find((c: any) => c.commandId === "test")).toMatchObject({ state: "FAILED", exitCode: 1 });
    const diff = (await call("GET", `/runs/${runId}/diff`)).body.data;
    expect(diff.warnings.some((x: any) => x.type === "check-failed")).toBe(true);
    expect((await call("POST", `/runs/${runId}/review`, { decision: "approve", diffHash: diff.diffHash })).status).toBe(422);
    expect((await call("POST", `/runs/${runId}/review`, { decision: "approve", diffHash: diff.diffHash, overrideQa: true })).status).toBe(422); // sin motivo
    const ok = await call("POST", `/runs/${runId}/review`, { decision: "approve", diffHash: diff.diffHash, overrideQa: true, reason: "El test falla por un problema preexistente" });
    expect(ok.status).toBe(200);
    const aud = get<{ detail: string }>(db, "SELECT detail FROM audit_event WHERE action='review.approve' AND entity_id=?", runId)!;
    expect(JSON.parse(aud.detail).qaOverride).toBe(true);
    await w.stop();
  });

  it("rechazar conserva la evidencia (RN-009) y needs_changes permite un nuevo intento (RN-012)", async () => {
    const w = startWorker({ db, config, providers }, 60_000);
    const { taskId, runId } = await newRun("mock-writer", "Tarea a rechazar");
    await startAndRun(runId, w);
    const diff = (await call("GET", `/runs/${runId}/diff`)).body.data;
    expect((await call("POST", `/runs/${runId}/review`, { decision: "needs_changes", diffHash: diff.diffHash, reason: "falta test" })).body.data.task.state).toBe("NEEDS_CHANGES");
    expect(get(db, "SELECT run_id FROM run_diff WHERE run_id=?", runId)).toBeTruthy();
    expect((await call("POST", `/tasks/${taskId}/transition`, { to: "READY", version: (await call("GET", `/tasks/${taskId}`)).body.data.version })).status).toBe(200);
    const again = await call("POST", `/tasks/${taskId}/runs`, { providerId: "mock-writer" });
    expect(again.body.data.attempt).toBe(2);
    await w.stop();
  });
});

describe("cancelación, timeout y recuperación", () => {
  it("T-007: cancelar un run en ejecución lo marca CANCELLED (no FAILED)", async () => {
    const w = startWorker({ db, config, providers }, 60_000);
    const { runId } = await newRun("slow", "Tarea larga");
    expect((await call("POST", `/runs/${runId}/approve-start`)).status).toBe(200);
    const done = w.tick();
    await new Promise((r) => setTimeout(r, 700));
    expect(get<{ state: string }>(db, "SELECT state FROM run WHERE id=?", runId)!.state).toBe("RUNNING");
    const c = await call("POST", `/runs/${runId}/cancel`);
    expect(c.status).toBe(202);
    await done;
    expect(get<{ state: string }>(db, "SELECT state FROM run WHERE id=?", runId)!.state).toBe("CANCELLED");
    // cancelar de nuevo no reescribe la historia
    expect((await call("POST", `/runs/${runId}/cancel`)).body.data.alreadyFinished).toBe(true);
    await w.stop();
  });

  it("cancelar antes de iniciar cancela run y job sin ejecutar nada", async () => {
    const { taskId, runId } = await newRun("mock-writer", "Cancelar en cola");
    await call("POST", `/runs/${runId}/approve-start`);
    expect((await call("POST", `/runs/${runId}/cancel`)).body.data.state).toBe("CANCELLED");
    expect(get<{ state: string }>(db, "SELECT state FROM task WHERE id=?", taskId)!.state).toBe("CANCELLED");
    expect(get<{ state: string }>(db, "SELECT state FROM job WHERE run_id=?", runId)!.state).toBe("DONE");
  });

  it("el timeout se registra como TIMED_OUT, distinto de fallo (RN-011)", async () => {
    const w = startWorker({ db, config: { ...config, runTimeoutMs: 300 }, providers }, 60_000);
    const { runId } = await newRun("slow", "Tarea que excede el tiempo");
    await startAndRun(runId, w);
    expect(get<{ state: string }>(db, "SELECT state FROM run WHERE id=?", runId)!.state).toBe("TIMED_OUT");
    await w.stop();
  });

  it("T-006: tras reinicio un run RUNNING pasa a UNKNOWN y no se reanuda", async () => {
    const { taskId, runId } = await newRun("mock", "Tarea huérfana");
    await call("POST", `/runs/${runId}/approve-start`);
    run(db, "UPDATE run SET state='RUNNING', version=version+1 WHERE id=?", runId);
    run(db, "UPDATE task SET state='RUNNING', version=version+1 WHERE id=?", taskId);
    expect(reconcileOrphans({ db, config, providers })).toBe(1);
    expect(get<{ state: string }>(db, "SELECT state FROM run WHERE id=?", runId)!.state).toBe("UNKNOWN");
    expect(get<{ state: string }>(db, "SELECT state FROM task WHERE id=?", taskId)!.state).toBe("UNKNOWN");
  });

  it("un proveedor sin integrar (codex) queda BLOCKED, nunca simula éxito", async () => {
    const w = startWorker({ db, config, providers }, 60_000);
    const { runId } = await newRun("codex", "Usar codex");
    await startAndRun(runId, w);
    const r = (await call("GET", `/runs/${runId}`)).body.data;
    expect(r.state).toBe("BLOCKED");
    expect(r.error).toMatch(/Codex/);
    await w.stop();
  });
});

describe("seguridad de la API", () => {
  it("rechaza sin sesión (401), sin CSRF (403) y con origen ajeno (403)", async () => {
    expect((await call("GET", "/projects", undefined, { auth: false })).status).toBe(401);
    expect((await call("POST", "/tasks", { projectId }, { csrf: false })).status).toBe(403);
    expect((await call("POST", "/roots", { path: base }, { origin: "http://evil.example" })).status).toBe(403);
  });
  it("T-002: registrar un repo fuera del root -> 403 y auditoría", async () => {
    const outside = path.join(base, "outside");
    await runCommand({ file: "git", args: ["init", outside], cwd: base, timeoutMs: 10_000 });
    const r = await call("POST", "/projects", { name: "x", repoPath: outside });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain(base); // sin rutas absolutas en errores
    expect(all(db, "SELECT id FROM audit_event WHERE action='project.register' AND outcome='DENIED'").length).toBeGreaterThanOrEqual(1);
  });
  it("traversal con .. y repos duplicados se rechazan", async () => {
    expect((await call("POST", "/projects", { name: "x", repoPath: path.join(repo, "..", "..", "outside") })).status).toBe(403);
    expect((await call("POST", "/projects", { name: "dup", repoPath: repo })).status).toBe(422);
  });
  it("T-003: tarea sin criterios queda DRAFT y no se puede ejecutar ni pasar a READY", async () => {
    const t = await call("POST", "/tasks", { projectId, title: "Sin criterios", type: "chore", priority: "low" });
    expect(t.body.data.state).toBe("DRAFT");
    expect((await call("POST", `/tasks/${t.body.data.id}/runs`, { providerId: "mock" })).status).toBe(422);
    expect((await call("POST", `/tasks/${t.body.data.id}/transition`, { to: "READY", version: 1 })).status).toBe(422);
  });
  it("campos desconocidos y estados forzados por el cliente se rechazan (mass assignment)", async () => {
    expect((await call("POST", "/tasks", { projectId, title: "abc", type: "bug", priority: "low", state: "APPROVED" })).status).toBe(400);
  });
  it("conflicto de versión -> 409", async () => {
    const t = await call("POST", "/tasks", { projectId, title: "Versionada", type: "chore", priority: "low" });
    expect((await call("PATCH", `/tasks/${t.body.data.id}`, { version: 1, title: "Nueva A" })).status).toBe(200);
    expect((await call("PATCH", `/tasks/${t.body.data.id}`, { version: 1, title: "Nueva B" })).status).toBe(409);
  });
  it("T-004: la clasificación cae a heurística sin bloquear si Ollama no responde", async () => {
    const t = await call("POST", "/tasks", { projectId, title: "Corregir error de login", type: "chore", priority: "low" });
    const c = await call("POST", `/tasks/${t.body.data.id}/classify`);
    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({ source: "heuristic", category: "bug", proposal: true });
    expect(get<{ state: string }>(db, "SELECT state FROM task WHERE id=?", t.body.data.id)!.state).toBe("DRAFT"); // no cambia estado (RN-006)
  });
  it("RF-027: las APIs de pago están apagadas por defecto", async () => {
    const p = (await call("GET", "/providers")).body.data;
    expect(p.paidApisEnabled).toBe(false);
  });
  it("la auditoría es append-only a nivel de base de datos", () => {
    expect(() => db.exec("UPDATE audit_event SET action='x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_event")).toThrow(/append-only/);
  });
  it("revocar sesión invalida la cookie; el login se limita tras 5 fallos", async () => {
    const l2 = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: PW } });
    const c2 = String(l2.headers["set-cookie"]).split(";")[0]!;
    const k2 = JSON.parse(l2.body).data.csrfToken;
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: c2, "x-csrf-token": k2 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: c2 } })).statusCode).toBe(401);
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "ghost", password: "bad" } })).statusCode;
    expect(last).toBe(429);
  });
  it("las cabeceras de seguridad y CSP están presentes", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("gestión de tareas (RF-006/007)", () => {
  const mk = async (title: string, priority = "low") => (await call("POST", "/tasks", { projectId, title, type: "chore", priority })).body.data;
  const list = async (qs: string) => (await call("GET", `/projects/${projectId}/tasks?${qs}`)).body.data as Array<{ title: string }>;

  it("archivar oculta la tarea de la lista pero conserva su historial (no se borra)", async () => {
    const t = await mk("Tarea para archivar zq1");
    expect((await call("POST", `/tasks/${t.id}/archive`)).status).toBe(200);
    expect((await list("q=zq1")).length).toBe(0);
    expect((await list("q=zq1&archived=true")).map((x) => x.title)).toEqual(["Tarea para archivar zq1"]);
    expect(get(db, "SELECT id FROM task WHERE id=?", t.id)).toBeTruthy();
    expect((await call("GET", `/tasks/${t.id}`)).body.data.history.length).toBeGreaterThan(0);
  });
  it("no se puede archivar una tarea en ejecución", async () => {
    const { taskId, runId } = await newRun("slow", "Tarea larga archivo");
    await call("POST", `/runs/${runId}/approve-start`);
    expect((await call("POST", `/tasks/${taskId}/archive`)).status).toBe(422);
    await call("POST", `/runs/${runId}/cancel`);
  });
  it("filtra por estado, ordena por prioridad y escapa comodines LIKE en la búsqueda", async () => {
    await mk("Orden alfa zq2", "low"); await mk("Orden beta zq2", "critical"); await mk("Orden gamma zq2", "high");
    expect((await list("q=zq2&sort=priority")).map((x) => x.title)).toEqual(["Orden beta zq2", "Orden gamma zq2", "Orden alfa zq2"]);
    expect((await list("q=zq2&state=DRAFT")).length).toBe(3);
    expect((await list("q=zq2&state=APPROVED")).length).toBe(0);
    await mk("Descuento 100% zq3");
    expect((await list("q=100%25")).map((x) => x.title)).toEqual(["Descuento 100% zq3"]); // '%' literal, no comodín
    expect((await list("q=%25")).length).toBe(1);
    expect((await call("GET", `/projects/${projectId}/tasks?state=HACK`)).status).toBe(400);
  });
  it("editar sólo en estados editables y con versión vigente", async () => {
    const t = await mk("Editable zq4");
    const ok = await call("PATCH", `/tasks/${t.id}`, { version: t.version, acceptanceCriteria: ["nuevo criterio"] });
    expect(ok.body.data.acceptanceCriteria).toEqual(["nuevo criterio"]);
    const { taskId, runId } = await newRun("mock", "No editable zq5");
    await call("POST", `/runs/${runId}/approve-start`);
    expect((await call("PATCH", `/tasks/${taskId}`, { version: 99, title: "Cambio ilegal" })).status).toBe(422); // QUEUED
    await call("POST", `/runs/${runId}/cancel`);
  });
  it("el proveedor ollama-local figura en /providers, con salud real (aquí: Ollama inaccesible)", async () => {
    const p = (await call("GET", "/providers")).body.data.providers.find((x: any) => x.id === "ollama-local");
    expect(p).toMatchObject({ costOrigin: "LOCAL", canWriteCode: true });
  });
});
