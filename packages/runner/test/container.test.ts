import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildDockerArgs, DockerSandbox, dockerAvailable, runCommand } from "../src/index.js";

it("crea checks limitados, con usuario no root y sin red ni bind del host", () => {
  const args = buildDockerArgs({ name: "run-test", volume: "qa", command: ["npm", "test"] });
  expect(args).toEqual(expect.arrayContaining(["--read-only", "no-new-privileges", "ALL", "none", "1000:1000"]));
  expect(args.some((arg) => arg.includes("type=bind"))).toBe(false);
  expect(() => buildDockerArgs({ name: "run-test", volume: "qa", command: [], source: "../repo" })).toThrow();
});

it.runIf(process.env["DEVPILOT_TEST_DOCKER"] === "1")("instala dependencias con scripts deshabilitados y aísla la red y el worktree", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "devpilot-docker-")));
  const repo = path.join(root, "repositorio aislado");
  mkdirSync(path.join(repo, "dep"), { recursive: true });
  const ac = new AbortController();
  const sandbox = new DockerSandbox(repo, "run_d0c0d0c000000001", 90_000, ac.signal,
    { cpus: 2, memoryMib: 2048, pids: 256, workspaceMib: 64 });
  try {
    expect(await dockerAvailable(repo)).toBe(true);
    writeFileSync(path.join(repo, "dep", "package.json"), JSON.stringify({ name: "local-dep", version: "1.0.0" }));
    writeFileSync(path.join(repo, "dep", "index.js"), "module.exports = 42;");
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "qa", version: "1.0.0", dependencies: { "local-dep": "file:./dep" },
      scripts: { postinstall: "node -e \"process.exit(19)\"" },
    }));
    const locked = await runCommand({ file: "npm", args: ["install", "--package-lock-only", "--offline", "--ignore-scripts"], cwd: repo, timeoutMs: 20_000 });
    expect(locked.exitCode, locked.stderr).toBe(0);
    const prepared = await sandbox.prepare();
    expect(prepared.exitCode, prepared.stderr).toBe(0);
    const script = [
      "const assert = require('node:assert/strict'); const fs = require('node:fs');",
      "assert.equal(require('local-dep'), 42); assert.equal(process.getuid(), 1000);",
      "assert.deepEqual(Object.keys(require('node:os').networkInterfaces()), ['lo']);",
      "assert.equal(fs.existsSync('/src'), false); fs.writeFileSync('local-output.txt', 'isolated');",
      "const volume = fs.statfsSync('/work'); assert.equal(volume.bsize * volume.blocks, 64 * 1024 ** 2);",
      "fetch('https://example.com', {signal: AbortSignal.timeout(2000)}).then(() => process.exit(30), () => {});",
    ].join(" ");
    const result = await sandbox.check("test", "node", ["-e", script]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(path.join(repo, "local-output.txt"))).toBe(false);
    expect(existsSync(path.join(repo, "node_modules"))).toBe(false);
    const running = sandbox.check("lint", "node", ["-e", "setTimeout(() => {}, 60000)"]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    ac.abort();
    expect((await running).cancelled).toBe(true);
    const remaining = await runCommand({ file: "docker", args: ["ps", "-aq", "--filter", "name=devpilot-run_d0c0d0c000000001-lint"], cwd: repo, timeoutMs: 10_000 });
    expect(remaining.stdout.trim()).toBe("");
  } finally {
    await sandbox.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
