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
};

const int = (v: string | undefined, d: number, min: number, max: number): number => {
  const n = v === undefined ? d : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

export function loadConfig(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Config {
  const dataDir = path.resolve(cwd, env["DATA_DIR"] ?? "data");
  const host = env["HOST"] ?? "127.0.0.1";
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
  };
}
