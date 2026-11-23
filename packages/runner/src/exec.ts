import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "@devpilot/security";

export type RunOptions = {
  file: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Variables extra permitidas (se suman al entorno mínimo). */
  env?: Record<string, string>;
};

export type RunResult = {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
};

const ENV_KEEP = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT", "LANG"];

/** Entorno mínimo: no hereda secretos del proceso padre (RNF-006, exfiltración). */
export function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_KEEP) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, CI: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
}

/**
 * En Windows `npm` es `npm.cmd` y Node no lo lanza sin shell. Se resuelve a
 * `node <npm-cli.js>` para mantener shell:false.
 */
export function resolveExecutable(file: string, args: readonly string[]): { file: string; args: string[] } {
  if (file === "npm") {
    const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(cli)) return { file: process.execPath, args: [cli, ...args] };
  }
  return { file, args: [...args] };
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    k.on("error", () => undefined);
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* ya terminó */ }
  }
}

/** Ejecuta un proceso tipado sin shell, con timeout, cancelación, kill del árbol y salida acotada y redactada. */
export function runCommand(opts: RunOptions): Promise<RunResult> {
  const max = opts.maxOutputBytes ?? 256 * 1024;
  const exe = resolveExecutable(opts.file, opts.args);
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(exe.file, exe.args, {
      cwd: opts.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
      env: minimalEnv(opts.env), stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (cur: string, chunk: Buffer): string => (cur.length >= max ? cur : cur + chunk.toString("utf8"));
    child.stdout.on("data", (c: Buffer) => { stdout = append(stdout, c); });
    child.stderr.on("data", (c: Buffer) => { stderr = append(stderr, c); });

    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs);
    const onAbort = () => { cancelled = true; killTree(child.pid); };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, extraErr = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode, timedOut, cancelled,
        stdout: redactSecrets(stdout.slice(0, max)),
        stderr: redactSecrets((stderr + extraErr).slice(0, max)),
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (e) => finish(null, `spawn error: ${e.message}`));
    child.on("close", (code) => finish(code));
  });
}
