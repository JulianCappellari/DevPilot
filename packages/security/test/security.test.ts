import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CommandDeniedError, PathPolicyError, containsSecret, isInside, isSensitivePath, redactSecrets,
  resolveCheck, resolveInsideAnyRoot, resolveInsideRoot,
} from "../src/index.js";

describe("redactSecrets (RNF-006, T-011)", () => {
  const cases: Array<[string, string]> = [
    ["Authorization: Bearer abc.DEF-123_xyz", "abc.DEF"],
    ["token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_"],
    ["key sk-ant-api03-abcdefghijklmnop1234", "sk-ant"],
    ["AWS AKIAABCDEFGHIJKLMNOP", "AKIA"],
    ["DATABASE_URL=postgresql://devpilot:SuperClave99@127.0.0.1:5432/db", "SuperClave99"],
    ['{"password": "hunter2"}', "hunter2"],
    ["API_KEY='abc123secret'", "abc123secret"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "eyJhbGci"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "MIIEow"],
  ];
  it.each(cases)("redacta %#", (input, leaked) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain("[REDACTED]");
    expect(containsSecret(input)).toBe(true);
  });
  it("no altera texto sin secretos", () => {
    const s = "Running tests: 12 passed, exit code 0";
    expect(redactSecrets(s)).toBe(s);
    expect(containsSecret(s)).toBe(false);
  });
  it("identifica rutas sensibles", () => {
    for (const p of [".env", "app/.env.local", "C:\\u\\.ssh\\id_rsa", "certs/server.pem", ".npmrc"])
      expect(isSensitivePath(p)).toBe(true);
    for (const p of ["src/env.ts", "README.md", "environment.md"]) expect(isSensitivePath(p)).toBe(false);
  });
});

describe("resolución de paths (RNF-004, RN-016, T-001/T-002)", () => {
  let base: string, root: string, outside: string;
  let symlinkOk = true;

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "devpilot-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    await mkdir(path.join(root, "repo"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "x");
    try {
      await symlink(outside, path.join(root, "escape"), "junction");
    } catch {
      symlinkOk = false;
    }
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const code = async (p: Promise<unknown>) => {
    try { await p; return "OK"; } catch (e) { return e instanceof PathPolicyError ? e.code : "OTHER"; }
  };

  it("acepta un repo dentro del root", async () => {
    await expect(resolveInsideRoot(root, path.join(root, "repo"))).resolves.toContain("repo");
  });
  it("acepta el propio root", async () => {
    await expect(resolveInsideRoot(root, root)).resolves.toBeTruthy();
  });
  it("rechaza rutas fuera del root", async () => {
    expect(await code(resolveInsideRoot(root, outside))).toBe("OUTSIDE_ROOT");
  });
  it("rechaza traversal con ..", async () => {
    expect(await code(resolveInsideRoot(root, path.join(root, "repo", "..", "..", "outside")))).toBe("OUTSIDE_ROOT");
  });
  it("rechaza un prefijo hermano (root vs root-evil)", async () => {
    await mkdir(path.join(base, "root-evil"), { recursive: true });
    expect(await code(resolveInsideRoot(root, path.join(base, "root-evil")))).toBe("OUTSIDE_ROOT");
  });
  it("rechaza symlink/junction que escapa del root", async (ctx) => {
    if (!symlinkOk) ctx.skip();
    expect(await code(resolveInsideRoot(root, path.join(root, "escape", "secret.txt")))).toBe("OUTSIDE_ROOT");
  });
  it("rechaza entradas inválidas y rutas inexistentes", async () => {
    expect(await code(resolveInsideRoot(root, ""))).toBe("INVALID_PATH");
    expect(await code(resolveInsideRoot(root, "a\0b"))).toBe("INVALID_PATH");
    expect(await code(resolveInsideRoot(root, "\\\\?\\C:\\Windows"))).toBe("INVALID_PATH");
    expect(await code(resolveInsideRoot(root, path.join(root, "nope")))).toBe("NOT_FOUND");
    expect(await code(resolveInsideRoot(path.join(base, "missing"), root))).toBe("NOT_FOUND");
  });
  it("no filtra rutas absolutas en los mensajes de error", async () => {
    const err = await resolveInsideRoot(root, outside).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(base);
  });
  it("resolveInsideAnyRoot elige el root correcto y falla si ninguno contiene", async () => {
    const r = await resolveInsideAnyRoot([outside, root], path.join(root, "repo"));
    expect(r.root).toBe(root);
    expect(await code(resolveInsideAnyRoot([outside], path.join(root, "repo")))).toBe("OUTSIDE_ROOT");
    expect(await code(resolveInsideAnyRoot([], root))).toBe("OUTSIDE_ROOT");
  });
  it("isInside es estricto con prefijos de nombre", () => {
    const r = path.resolve("/a/root");
    expect(isInside(r, path.resolve("/a/root/x"))).toBe(true);
    expect(isInside(r, path.resolve("/a/root-evil"))).toBe(false);
    expect(isInside(r, path.resolve("/a"))).toBe(false);
  });
});

describe("allowlist de comandos (T-008, §13.2)", () => {
  it("resuelve checks conocidos y habilitados como argv tipado", () => {
    expect(resolveCheck("lint", ["lint", "test"])).toEqual({ file: "npm", args: ["run", "lint"] });
  });
  it("rechaza comandos libres, inyección y ids heredados de Object.prototype", () => {
    for (const bad of ["rm -rf /", "lint; whoami", "constructor", "__proto__", "toString", ""]) {
      expect(() => resolveCheck(bad, [bad, "lint"])).toThrow(CommandDeniedError);
    }
  });
  it("rechaza checks no habilitados para el proyecto", () => {
    try { resolveCheck("test", ["lint"]); expect.unreachable(); }
    catch (e) { expect((e as CommandDeniedError).code).toBe("NOT_ENABLED_FOR_PROJECT"); }
  });
  it("devuelve una copia: mutar el resultado no altera la allowlist", () => {
    const c = resolveCheck("lint", ["lint"]);
    (c.args as string[]).push("--evil");
    expect(resolveCheck("lint", ["lint"]).args).toEqual(["run", "lint"]);
  });
});
