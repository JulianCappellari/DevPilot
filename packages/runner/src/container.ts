import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { runCommand, type RunResult } from "./exec.js";

const IMAGE = "node:24-slim";
const SECURITY = ["--cap-drop", "ALL",
  "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
  "-e", "HOME=/tmp", "-e", "CI=1"];
export type SandboxLimits = { cpus: number; memoryMib: number; pids: number; workspaceMib: number };
const DEFAULT_LIMITS: SandboxLimits = { cpus: 2, memoryMib: 2048, pids: 256, workspaceMib: 512 };

export async function dockerAvailable(cwd: string): Promise<boolean> {
  const result = await runCommand({ file: "docker", args: ["info", "--format", "{{.OSType}}"], cwd, timeoutMs: 5_000 });
  return result.exitCode === 0 && result.stdout.trim() === "linux";
}

export async function cleanupDockerRun(runId: string, cwd: string): Promise<void> {
  if (!/^run_[a-f0-9]{16}$/.test(runId)) return;
  const name = `devpilot-${runId}`;
  await runCommand({ file: "docker", args: ["rm", "-f", ...["prepare", "install", "lint", "test", "typecheck", "build", "keeper"].map((stage) => `${name}-${stage}`)], cwd, timeoutMs: 8_000 });
  await runCommand({ file: "docker", args: ["volume", "rm", name], cwd, timeoutMs: 8_000 });
}

export function buildDockerArgs(options: {
  name: string; volume: string; command: readonly string[]; install?: boolean; source?: string;
  limits?: SandboxLimits; detached?: boolean;
}): string[] {
  const { name, volume, command, install, source, limits = DEFAULT_LIMITS, detached } = options;
  const args = ["run", "--rm", ...(detached ? ["--detach"] : []), "--name", name,
    "--cpus", String(limits.cpus), "--memory", `${limits.memoryMib}m`, "--pids-limit", String(limits.pids), ...SECURITY, "--network", install ? "bridge" : "none",
    "--mount", `type=volume,source=${volume},target=/work,volume-nocopy`, "--workdir", "/work"];
  if (source) {
    if (!path.isAbsolute(source) || /[,"\r\n]/.test(source)) throw new Error("La ruta del worktree no es válida para el montaje de Docker");
    args.push("--mount", `type=bind,source=${source},target=/src,readonly`, "--cap-add", "CHOWN");
  } else args.push("--user", "1000:1000");
  return [...args, IMAGE, ...command];
}

export class DockerSandbox {
  private readonly volume: string;

  constructor(private readonly cwd: string, runId: string, private readonly timeoutMs: number, private readonly signal: AbortSignal,
    private readonly limits: SandboxLimits = DEFAULT_LIMITS) {
    if (!/^run_[a-f0-9]{16}$/.test(runId)) throw new Error("ID de ejecución no válido para Docker");
    this.volume = `devpilot-${runId}`;
  }

  private docker(args: string[], cleanup = false): Promise<RunResult> {
    return runCommand({ file: "docker", args, cwd: this.cwd, timeoutMs: cleanup ? 10_000 : this.timeoutMs, ...(cleanup ? {} : { signal: this.signal }) });
  }

  private async container(stage: string, command: string[], options: { install?: boolean; source?: string } = {}): Promise<RunResult> {
    const name = `${this.volume}-${stage}`;
    try {
      return await this.docker(buildDockerArgs({ name, volume: this.volume, command, limits: this.limits, ...options }));
    } finally {
      await this.docker(["rm", "-f", name], true);
    }
  }

  async prepare(): Promise<RunResult> {
    const source = realpathSync(this.cwd);
    const volume = await this.docker(["volume", "create", "--label", "devpilot.sandbox=true",
      "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs",
      "--opt", `o=size=${this.limits.workspaceMib}m,nosuid,nodev`, this.volume]);
    if (volume.exitCode !== 0 || volume.cancelled || volume.timedOut) return volume;
    // Mantiene montado el tmpfs entre la preparación y los checks.
    const keeper = await this.docker(buildDockerArgs({ name: `${this.volume}-keeper`, volume: this.volume,
      command: ["sleep", "infinity"], limits: this.limits, detached: true }));
    if (keeper.exitCode !== 0 || keeper.cancelled || keeper.timedOut) return keeper;
    const copy = await this.container("prepare", ["sh", "-ec",
      "tar -C /src --exclude=.git --exclude=node_modules -cf /tmp/devpilot.tar . && tar -C /work --no-same-owner --no-same-permissions -xf /tmp/devpilot.tar && chown -hR 1000:1000 /work"], { source });
    if (copy.exitCode !== 0 || copy.cancelled || copy.timedOut) return copy;
    const manifest = path.join(source, "package.json");
    const locked = ["package-lock.json", "npm-shrinkwrap.json"].some((name) => existsSync(path.join(source, name)));
    if (!locked && !existsSync(manifest)) return copy;
    if (!locked) {
      const project = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, object>;
      const needsInstall = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "workspaces"]
        .some((key) => Object.keys(project[key] ?? {}).length > 0);
      if (!needsInstall) return copy;
    }
    return this.container("install", ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", "/tmp/npm-cache"], { install: true });
  }

  check(id: string, file: string, args: readonly string[]): Promise<RunResult> {
    return this.container(id, [file, ...args]);
  }

  async close(): Promise<void> {
    await this.docker(["rm", "-f", `${this.volume}-keeper`], true);
    await this.docker(["volume", "rm", this.volume], true);
  }
}
