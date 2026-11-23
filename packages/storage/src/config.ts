import path from "node:path";
import { parsePaidApisFlag } from "@devpilot/domain";

export type Config = {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  workspaceRoot: string;
  projectRoots: string[];
  ollamaBaseUrl: string;
  ollamaModel: string;
  enablePaidApis: boolean;
  maxActiveRuns: number;
  runTimeoutMs: number;
  checkTimeoutMs: number;
  sessionTtlMs: number;
  cookieSecure: boolean;
  logRedaction: boolean;
  sandbox: "none" | "docker";
  sandboxLimits: { cpus: number; memoryMib: number; pids: number; workspaceMib: number };
  codexMode: "off" | "read-only" | "write";
  allowedOrigins: string[];
  embeddedWorker: boolean;
  backupIntervalMs: number;
  githubPrEnabled: boolean;
  githubReadEnabled: boolean;
};

function choice<const T extends string>(name: string, value: string | undefined, choices: readonly T[]): T {
  if (value === undefined || value === "") return choices[0]!;
  if (choices.includes(value as T)) return value as T;
  throw new Error(`${name}: usá uno de ${choices.join(", ")}`);
}

export function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

const int = (v: string | undefined, d: number, min: number, max: number): number => {
  const n = v === undefined ? d : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

export function loadConfig(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Config {
  const dataDir = path.resolve(cwd, env["DATA_DIR"] ?? "data");
  const host = env["HOST"] ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error("HOST debe ser loopback. Usá un proxy HTTPS privado para el acceso remoto");
  return {
    host,
    port: int(env["PORT"], 4000, 0, 65535),
    dataDir,
    dbFile: path.join(dataDir, "devpilot.db"),
    workspaceRoot: path.resolve(cwd, env["WORKSPACE_ROOT"] ?? path.join(dataDir, "worktrees")),
    projectRoots: (env["PROJECT_ROOTS"] ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(cwd, s)),
    ollamaBaseUrl: env["OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434",
    ollamaModel: env["OLLAMA_MODEL"] ?? "gemma4:12b",
    enablePaidApis: parsePaidApisFlag(env["ENABLE_PAID_APIS"]),
    maxActiveRuns: int(env["MAX_ACTIVE_RUNS"], 1, 1, 1), // MVP: una escritora activa (RNF-015)
    runTimeoutMs: int(env["RUN_TIMEOUT_MINUTES"], 30, 1, 240) * 60_000,
    checkTimeoutMs: int(env["CHECK_TIMEOUT_SECONDS"], 300, 1, 3600) * 1000,
    sessionTtlMs: int(env["SESSION_TTL_HOURS"], 12, 1, 720) * 3_600_000,
    cookieSecure: env["COOKIE_SECURE"] === "true",
    logRedaction: env["LOG_REDACTION"] !== "false",
    sandbox: choice("SANDBOX", env["SANDBOX"], ["none", "docker"]),
    sandboxLimits: {
      cpus: int(env["SANDBOX_CPUS"], 2, 1, 8),
      memoryMib: int(env["SANDBOX_MEMORY_MIB"], 2048, 256, 8192),
      pids: int(env["SANDBOX_PIDS"], 256, 32, 1024),
      workspaceMib: int(env["SANDBOX_WORKSPACE_MIB"], 512, 64, 4096),
    },
    codexMode: choice("CODEX_MODE", env["CODEX_MODE"], ["off", "read-only", "write"]),
    allowedOrigins: (env["ALLOWED_ORIGINS"] ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
      const origin = parseOrigin(value);
      if (!origin || !origin.startsWith("https://")) throw new Error("ALLOWED_ORIGINS requiere orígenes HTTPS exactos");
      return origin;
    }),
    embeddedWorker: env["EMBEDDED_WORKER"] !== "false",
    backupIntervalMs: int(env["BACKUP_INTERVAL_HOURS"], 24, 0, 168) * 3_600_000,
    githubPrEnabled: env["ENABLE_GITHUB_PR"] === "true",
    githubReadEnabled: env["ENABLE_GITHUB_READ"] === "true",
  };
}
