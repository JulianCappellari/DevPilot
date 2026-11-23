import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "@devpilot/security";

export type RunOptions = {
  file: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  input?: string;
  onStdoutLine?: (line: string) => void;
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
  stdoutTruncated?: boolean;
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
  if (opts.signal?.aborted) return Promise.resolve({ exitCode: null, timedOut: false, cancelled: true, stdout: "", stderr: "", durationMs: 0 });
  const max = opts.maxOutputBytes ?? 256 * 1024;
  const exe = resolveExecutable(opts.file, opts.args);
  const started = Date.now();
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(exe.file, exe.args, {
      cwd: opts.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
      env: minimalEnv(opts.env), stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.input);
    const decoder = new StringDecoder("utf8");
    let partial = "";
    let discard = false;
    const receiveLines = (value: string) => {
      const lines = value.split("\n");
      for (const line of lines.slice(0, -1)) {
        if (!discard && partial.length + line.length <= max) opts.onStdoutLine?.((partial + line).replace(/\r$/, ""));
        partial = "";
        discard = false;
      }
      if (!discard) partial += lines.at(-1) ?? "";
      if (partial.length > max) { partial = ""; discard = true; }
    };
    child.stdout!.on("data", (c: Buffer) => {
      const accepted = c.subarray(0, Math.max(0, max - stdoutBytes));
      if (accepted.length) stdout.push(accepted);
      stdoutBytes += accepted.length;
      stdoutTruncated ||= accepted.length !== c.length;
      if (opts.onStdoutLine) receiveLines(decoder.write(c));
    });
    child.stdout!.on("end", () => { if (opts.onStdoutLine) receiveLines(decoder.end() + "\n"); });
    child.stderr!.on("data", (c: Buffer) => {
      const accepted = c.subarray(0, Math.max(0, max - stderrBytes));
      if (accepted.length) stderr.push(accepted);
      stderrBytes += accepted.length;
    });

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
        stdout: redactSecrets(Buffer.concat(stdout).toString("utf8")),
        stderr: redactSecrets((Buffer.concat(stderr).toString("utf8") + extraErr).slice(0, max)),
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (e) => finish(null, `spawn error: ${e.message}`));
    child.on("close", (code) => finish(code));
  });
}
