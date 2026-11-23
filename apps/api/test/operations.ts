import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { runCommand } from "@devpilot/runner";
import { fixture } from "../../web/browser/server.js";
import { createDemoRepo } from "../src/seed.js";

type Envelope<T> = { data: T; error: { message: string } | null };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function session(url: string, password: string) {
  const login = await fetch(url + "/api/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0]?.split(";")[0];
  assert.ok(cookie);
  const { data } = await login.json() as Envelope<{ csrfToken: string }>;
  return async <T>(route: string, method = "GET", body?: object): Promise<T> => {
    const result = await fetch(url + "/api/v1" + route, { method, headers: {
      cookie, "x-csrf-token": data.csrfToken, ...(body ? { "content-type": "application/json" } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await result.json() as Envelope<T>;
    assert.equal(result.status, 200, json.error?.message);
    return json.data;
  };
}

const demo = await fixture();
let server: Awaited<ReturnType<typeof demo.start>> | undefined;
let worker: Awaited<ReturnType<typeof demo.startWorker>> | undefined;
const cli = async (dataDir: string, ...args: string[]) => {
  const result = await runCommand({ file: process.execPath, args: ["--import", "tsx", "apps/api/src/cli.ts", ...args],
    cwd: process.cwd(), timeoutMs: 20_000, env: { DATA_DIR: dataDir } });
  assert.equal(result.exitCode, 0, result.stderr);
};
try {
  writeFileSync(path.join(demo.repo, "scripts", "check.js"), "require('node:fs').writeFileSync('worker-check-started', 'yes'); setTimeout(() => {}, 90000);\n");
  for (const args of [["add", "scripts/check.js"], ["commit", "-m", "Check largo para simulacro"]]) {
    const git = await runCommand({ file: "git", args: ["-c", "user.name=DevPilot", "-c", "user.email=devpilot@localhost", ...args], cwd: demo.repo, timeoutMs: 10_000 });
    assert.equal(git.exitCode, 0, git.stderr);
  }
  server = await demo.start();
  let api = await session(server.url, demo.password);
  const samples: number[] = [];
  const duration = 20_000;
  const end = performance.now() + duration;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (performance.now() < end) {
      const start = performance.now();
      await api("/dashboard");
      samples.push(performance.now() - start);
    }
  }));
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
  assert.ok(p95 < 500, `p95 fuera del objetivo: ${p95.toFixed(2)} ms`);
  console.log(`Carga: ${samples.length} solicitudes, 10 concurrentes, 20 s, p95 ${p95.toFixed(2)} ms · ${cpus()[0]?.model ?? process.arch}`);

  const project = await api<{ id: string }>("/projects", "POST", { name: "Caos", repoPath: demo.repo, enabledChecks: ["test"] });
  const task = await api<{ id: string }>("/tasks", "POST", { projectId: project.id, title: "Prueba de recuperación", type: "test", priority: "medium", acceptanceCriteria: ["Conservar auditoría"] });
  const { id } = await api<{ id: string }>(`/tasks/${task.id}/runs`, "POST", { providerId: "mock-writer" });
  await api(`/runs/${id}/approve-start`, "POST");
  const marker = path.join(demo.root, "worktrees", id, "worker-check-started");
  const deadline = Date.now() + 20_000;
  while (!existsSync(marker) && Date.now() < deadline) await sleep(100);
  assert.ok(existsSync(marker), "El proceso de QA no empezó");
  await server.stop();
  server = await demo.start();
  api = await session(server.url, demo.password);
  const interrupted = await api<{ state: string; task: { state: string } }>(`/runs/${id}`);
  assert.equal(interrupted.state, "UNKNOWN");
  assert.equal(interrupted.task.state, "UNKNOWN");
  console.log("Corte real: QA interrumpido, ejecución y tarea en UNKNOWN al reiniciar.");

  await cli(demo.dataDir, "backup");
  const folder = path.join(demo.dataDir, "backups");
  const copy = readdirSync(folder).find((name) => name.endsWith(".db"));
  assert.ok(copy);
  await server.stop();
  const restoredDir = path.join(demo.root, "restored");
  await cli(restoredDir, "restore", path.join(folder, copy));
  const useCodex = process.env["DEVPILOT_TEST_CODEX"] === "1";
  const restoreEnv = { DATA_DIR: restoredDir, EMBEDDED_WORKER: "false", ...(useCodex ? { CODEX_MODE: "write" } : {}) };
  server = await demo.start(restoreEnv);
  api = await session(server.url, demo.password);
  assert.equal((await api<{ state: string }>(`/runs/${id}`)).state, "UNKNOWN");
  const history = await api<Array<{ action: string; entityId: string }>>("/audit");
  assert.ok(history.some((entry) => entry.action === "run.finished" && entry.entityId === id), "Falta auditoría de la ejecución restaurada");
  console.log("Restauración en un DATA_DIR vacío: estado y auditoría conservados.");

  {
    const synthetic = await createDemoRepo(path.join(demo.root, "projects", "worker-sintetico"));
    const project = await api<{ id: string }>("/projects", "POST", { name: "Worker sintético", repoPath: synthetic, enabledChecks: ["lint"] });
    const task = await api<{ id: string }>("/tasks", "POST", {
      projectId: project.id, title: "Creá solamente comprobacion.md en la raíz del repo", type: "docs", priority: "low",
      acceptanceCriteria: ["El archivo nuevo contiene DevPilot modelo OK seguido de un salto de línea", "No modifiques otros archivos"],
    });
    const execution = await api<{ id: string; state: string }>(`/tasks/${task.id}/runs`, "POST", {
      providerId: useCodex ? "codex" : "mock-writer", acknowledgeExternal: useCodex,
    });
    assert.equal(execution.state, "PENDING_APPROVAL");
    await api(`/runs/${execution.id}/approve-start`, "POST");
    assert.equal((await api<{ state: string }>(`/runs/${execution.id}`)).state, "QUEUED");
    worker = await demo.startWorker(restoreEnv);
    let status: { state: string; error: string; task: { state: string } };
    const until = Date.now() + 95_000;
    do {
      status = await api(`/runs/${execution.id}`);
      if (!["QUEUED", "RUNNING"].includes(status.state)) break;
      await sleep(500);
    } while (Date.now() < until);
    assert.equal(status.state, "SUCCEEDED", status.error);
    assert.equal(status.task.state, "REVIEW_PENDING");
    const diff = await api<{ patch: string; diffHash: string; files: { path: string }[] }>(`/runs/${execution.id}/diff`);
    assert.deepEqual(diff.files.map((file) => file.path), [useCodex ? "comprobacion.md" : `devpilot-notes/${execution.id}.md`]);
    assert.match(diff.patch, /DevPilot modelo OK/);
    const review = await api<{ commit: string }>(`/runs/${execution.id}/review`, "POST", { decision: "approve", diffHash: diff.diffHash });
    assert.match(review.commit, /^[a-f0-9]{40,64}$/);
    console.log(useCodex
      ? "Codex real y worker separado: aviso confirmado, inicio autorizado, worktree, QA, diff y commit revisado."
      : "Worker separado: job reclamado, QA, diff y commit revisado.");
  }
} finally { await worker?.stop(); await server?.stop(); demo.remove(); }
