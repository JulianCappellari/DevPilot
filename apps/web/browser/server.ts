import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand } from "@devpilot/runner";
import { createDemoRepo } from "../../api/src/seed.js";

async function startProcess(entry: string, env: Record<string, string>, match: (line: string) => string | undefined) {
  const controller = new AbortController();
  let ready: (value: string) => void = () => undefined;
  const started = new Promise<string>((resolve) => { ready = resolve; });
  const finished = runCommand({
    file: process.execPath, args: ["--import", "tsx", entry], cwd: process.cwd(), env,
    timeoutMs: 150_000, signal: controller.signal,
    onStdoutLine(line) {
      const value = match(line);
      if (value) ready(value);
    },
  });
  const value = await Promise.race([started, finished.then((result) => { throw new Error(result.stderr || "DevPilot se cerró antes de arrancar"); })]);
  return { value, async stop() { controller.abort(); await finished; } };
}

export async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "devpilot-browser-")));
  const projects = path.join(root, "projects");
  const dataDir = path.join(root, "data");
  const password = randomUUID();
  const repo = await createDemoRepo(projects);
  const env = {
    DATA_DIR: dataDir, PROJECT_ROOTS: projects, WORKSPACE_ROOT: path.join(root, "worktrees"), HOST: "127.0.0.1", PORT: "0",
    BACKUP_INTERVAL_HOURS: "0", COOKIE_SECURE: "false", CODEX_MODE: "off", SANDBOX: "none", EMBEDDED_WORKER: "true",
    ENABLE_GITHUB_PR: "false", ENABLE_PAID_APIS: "false", OLLAMA_BASE_URL: "http://127.0.0.1:1",
  };
  const setup = await runCommand({ file: process.execPath, args: ["--import", "tsx", "apps/api/src/cli.ts", "setup"],
    cwd: process.cwd(), env: { ...env, DEVPILOT_OWNER_PASSWORD: password }, timeoutMs: 20_000 });
  if (setup.exitCode !== 0) throw new Error(setup.stderr);
  return {
    root, dataDir, repo, password,
    async start(overrides: Record<string, string> = {}) {
      const process = await startProcess("apps/api/src/main.ts", { ...env, ...overrides },
        (line) => /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1]);
      return { url: process.value, stop: process.stop };
    },
    async startWorker(overrides: Record<string, string>) {
      return startProcess("apps/worker/src/main.ts", { ...env, ...overrides },
        (line) => line.includes('"message":"Worker listo"') ? "ready" : undefined);
    },
    remove() { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); },
  };
}
