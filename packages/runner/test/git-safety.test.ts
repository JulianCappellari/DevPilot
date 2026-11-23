import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { addWorktree, headSha, runCommand, snapshotDiff } from "../src/index.js";

it("protege secretos antes de generar objetos Git y no permite revisar una salida truncada", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "devpilot-safe-diff-")));
  const source = path.join(dir, "repo");
  const worktree = path.join(dir, "worktree");
  mkdirSync(source);
  const git = async (args: string[], cwd = source) => {
    const result = await runCommand({ file: "git", cwd, args, timeoutMs: 10000 });
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    writeFileSync(path.join(source, "README.md"), "initial\n");
    await git(["init", "-b", "main"]);
    await git(["add", "README.md"]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "initial"]);
    const base = await headSha(source);
    await addWorktree(source, worktree, "devpilot/run_9876543210abcdef", base);
    writeFileSync(path.join(worktree, ".env"), "FIXTURE=private\n");
    await expect(snapshotDiff(worktree, base)).rejects.toThrow(/sensible/);
    expect((await git(["ls-files", "--", ".env"], worktree)).trim()).toBe("");
    rmSync(path.join(worktree, ".env"));
    writeFileSync(path.join(worktree, "README.md"), "contenido de prueba largo\n".repeat(18000));
    await expect(snapshotDiff(worktree, base)).rejects.toThrow(/supera el límite/);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}, 15000);
