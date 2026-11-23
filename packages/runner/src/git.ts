import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "./exec.js";
import { isSensitivePath } from "@devpilot/security";

const EMPTY_HOOKS = mkdtempSync(path.join(tmpdir(), "devpilot-nohooks-"));

/** Git sobre repos no confiables: sin hooks, sin fsmonitor, sin prompts. */
const SAFE = ["-c", `core.hooksPath=${EMPTY_HOOKS}`, "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "-c", "core.quotepath=false", "-c", "submodule.recurse=false"];

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
  if (r.stdoutTruncated) throw new GitError("La evidencia Git supera el límite de salida y no se puede revisar completa", null);
  return r.stdout;
}

async function withoutFilters(cwd: string): Promise<string[]> {
  const probe = await runCommand({ file: "git", args: [...SAFE, "config", "--name-only", "--get-regexp", "^filter\\."], cwd, timeoutMs: 5000 });
  if (probe.exitCode === 1 && !probe.stdout && !probe.stderr) return [];
  if (probe.exitCode !== 0 || probe.stdoutTruncated)
    throw new GitError("No se pudo revisar la configuración de filtros Git", probe.exitCode);
  const filters = new Set<string>();
  for (const key of probe.stdout.trim().split("\n")) {
    const name = /^filter\.([\w.-]+)\.[\w-]+$/.exec(key.trim())?.[1];
    if (!name) throw new GitError("Hay un filtro Git incompatible con la ejecución aislada", null);
    filters.add(name);
  }
  return [...filters].flatMap((name) => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`]);
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
  const porcelain = (await git(dir, [...await withoutFilters(dir), "status", "--porcelain"])).split("\n").filter(Boolean);
  const log = await git(dir, ["log", "-1", "--format=%H%x09%s"]).catch(() => "");
  const [sha, ...subject] = log.trim().split("\t");
  return { branch, dirty: porcelain.length > 0, changedFiles: porcelain.length, lastCommit: sha ? { sha, subject: subject.join("\t") } : null };
}

export async function addWorktree(repo: string, worktreePath: string, branch: string, base: string): Promise<void> {
  if (!isSafeBranchName(branch)) throw new GitError("Nombre de rama inválido", null);
  if (!/^[0-9a-f]{7,64}$/.test(base)) throw new GitError("Commit base inválido", null);
  await git(repo, [...await withoutFilters(repo), "worktree", "add", "-b", branch, worktreePath, base], 120_000);
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
}

export type ChangedFile = { path: string; status: "added" | "modified" | "deleted" | "renamed" };
export type DiffSnapshot = { files: ChangedFile[]; patch: string; hash: string; tree: string };

const STATUS: Record<string, ChangedFile["status"]> = { A: "added", M: "modified", D: "deleted", R: "renamed" };

/** Foto contra el commit base. El árbol de Git liga la aprobación a todos los bytes revisados. */
export async function snapshotDiff(worktree: string, base: string): Promise<DiffSnapshot> {
  const filterOptions = await withoutFilters(worktree);
  const changes = await git(worktree, [...filterOptions, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  if (changes.split("\0").some((entry) => entry && isSensitivePath(entry.slice(3))))
    throw new GitError("El worktree cambió un archivo sensible. Se bloqueó la captura del diff.", null);
  await git(worktree, [...filterOptions, "add", "-A"]);
  const tree = (await git(worktree, ["write-tree"])).trim();
  const names = (await git(worktree, ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, tree])).split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < names.length; i += 2) {
    files.push({ path: names[i + 1]!, status: STATUS[names[i]?.[0] ?? "M"] ?? "modified" });
  }
  const patch = files.some((file) => isSensitivePath(file.path)) ? "" :
    await git(worktree, ["diff", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", base, tree], 60_000);
  return { files, patch, tree, hash: createHash("sha256").update(base).update("\0").update(tree).digest("hex") };
}

export async function commitReviewedTree(worktree: string, branch: string, base: string, tree: string, message: string): Promise<string> {
  if (!/^devpilot\/run_[a-f0-9]{16}$/.test(branch) || ![base, tree].every((sha) => /^[a-f0-9]{40,64}$/.test(sha)))
    throw new GitError("Datos inválidos del árbol aprobado", null);
  const sha = (await git(worktree, ["-c", "user.name=DevPilot", "-c", "user.email=devpilot@localhost", "commit-tree", tree, "-p", base, "-m", message])).trim();
  await git(worktree, ["update-ref", `refs/heads/${branch}`, sha, base]);
  return sha;
}

export async function githubDestination(repo: string): Promise<{ slug: string; url: string }> {
  const fetchUrl = (await git(repo, ["remote", "get-url", "origin"])).trim();
  const pushUrl = (await git(repo, ["remote", "get-url", "--push", "--all", "origin"])).trim();
  const parse = (value: string) => /^(?:https:\/\/github\.com\/|git@github\.com:)([a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100})$/i.exec(value)?.[1]?.replace(/\.git$/i, "");
  const slug = parse(pushUrl);
  if (!slug || slug.toLowerCase() !== parse(fetchUrl)?.toLowerCase()) throw new GitError("origin debe apuntar a un único repositorio de github.com", null);
  return { slug, url: `https://github.com/${slug}.git` };
}

export async function pushDeliveredBranch(repo: string, url: string, runId: string, sha: string): Promise<void> {
  if (!/^https:\/\/github\.com\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}\.git$/i.test(url) ||
      !/^run_[a-f0-9]{16}$/.test(runId) || !/^[a-f0-9]{40,64}$/.test(sha)) throw new GitError("Destino o commit de publicación inválido", null);
  const ref = `refs/heads/devpilot/${runId}`;
  if ((await git(repo, ["rev-parse", "--verify", ref])).trim() !== sha) throw new GitError("La rama entregada cambió después de su aprobación", null);
  if ((await git(repo, ["ls-remote", "--get-url", url])).trim() !== url)
    throw new GitError("La configuración de Git reescribe el destino de publicación", null);
  await git(repo, ["-c", "credential.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential",
    "-c", "http.followRedirects=false", "-c", "push.followTags=false", "-c", "push.recurseSubmodules=no",
    "push", "--no-verify", "--porcelain", url, `${sha}:${ref}`], 45_000);
}
