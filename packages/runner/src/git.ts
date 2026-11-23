import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "./exec.js";

const EMPTY_HOOKS = mkdtempSync(path.join(tmpdir(), "devpilot-nohooks-"));

/** Git sobre repos no confiables: sin hooks, sin fsmonitor, sin prompts. */
const SAFE = ["-c", `core.hooksPath=${EMPTY_HOOKS}`, "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "-c", "core.quotepath=false"];

export class GitError extends Error {
  constructor(message: string, readonly exitCode: number | null) {
    super(message);
    this.name = "GitError";
  }
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
export const isSafeBranchName = (b: string): boolean => BRANCH_RE.test(b) && !b.includes("..") && !b.endsWith("/") && !b.endsWith(".lock");

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const r = await runCommand({ file: "git", args: [...SAFE, ...args], cwd, timeoutMs });
  if (r.exitCode !== 0) throw new GitError(`git ${args[0] ?? ""} falló: ${r.stderr.trim().slice(0, 300)}`, r.exitCode);
  return r.stdout;
}

export type GitStatus = { branch: string; lastCommit: { sha: string; subject: string } | null; dirty: boolean; changedFiles: number };

export async function topLevel(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
}

export async function headSha(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

export async function gitStatus(dir: string): Promise<GitStatus> {
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD")).trim();
  const porcelain = (await git(dir, ["status", "--porcelain"])).split("\n").filter(Boolean);
  const log = await git(dir, ["log", "-1", "--format=%H%x09%s"]).catch(() => "");
  const [sha, ...subject] = log.trim().split("\t");
  return { branch, dirty: porcelain.length > 0, changedFiles: porcelain.length, lastCommit: sha ? { sha, subject: subject.join("\t") } : null };
}

export async function addWorktree(repo: string, worktreePath: string, branch: string, base: string): Promise<void> {
  if (!isSafeBranchName(branch)) throw new GitError("Nombre de rama inválido", null);
  if (!/^[0-9a-f]{7,64}$/.test(base)) throw new GitError("Commit base inválido", null);
  await git(repo, ["worktree", "add", "-b", branch, worktreePath, base], 120_000);
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
}

export type ChangedFile = { path: string; status: "added" | "modified" | "deleted" | "renamed" };
export type DiffSnapshot = { files: ChangedFile[]; patch: string; hash: string };

const STATUS: Record<string, ChangedFile["status"]> = { A: "added", M: "modified", D: "deleted", R: "renamed" };

/** Foto del cambio del worktree contra su commit base. El hash cubre base + parche (TOCTOU, RN-020). */
export async function snapshotDiff(worktree: string, base: string): Promise<DiffSnapshot> {
  await git(worktree, ["add", "-A"]);
  const names = await git(worktree, ["diff", "--cached", "--name-status", "--no-renames", base]);
  const patch = await git(worktree, ["diff", "--cached", "--no-renames", "--no-color", base], 60_000);
  const files = names.split("\n").filter(Boolean).map((l): ChangedFile => {
    const [st = "M", ...rest] = l.split("\t");
    return { path: rest.join("\t"), status: STATUS[st[0] ?? "M"] ?? "modified" };
  });
  return { files, patch, hash: createHash("sha256").update(base).update("\0").update(patch).digest("hex") };
}

export async function commitAll(worktree: string, message: string): Promise<string> {
  await git(worktree, ["add", "-A"]);
  await git(worktree, ["-c", "user.name=DevPilot", "-c", "user.email=devpilot@localhost", "commit", "--no-verify", "--allow-empty", "-m", message]);
  return headSha(worktree);
}
