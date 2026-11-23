import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OllamaProvider, UnsafePathError, buildPrompt, safeTargetPath, type AgentEvent, type AgentRequest } from "../src/index.js";

let base: string, wt: string, outside: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dp-ollama-")));
  wt = path.join(base, "wt");
  outside = path.join(base, "outside");
  mkdirSync(wt, { recursive: true });
  mkdirSync(outside, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const req = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  runId: "r1", projectId: "p1", worktreePath: wt, task: "Documentar", acceptanceCriteria: ["README explica el uso"],
  policy: { readOnly: false, timeoutMs: 5000 }, contextRefs: [], ...over,
});
const collect = async (it: AsyncIterable<AgentEvent>) => { const out: AgentEvent[] = []; for await (const e of it) out.push(e); return out; };
const stub = (proposal: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify({ response: typeof proposal === "string" ? proposal : JSON.stringify(proposal) }), { status })) as unknown as typeof fetch;
const provider = (f: typeof fetch) => new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "gemma4:12b", fetchImpl: f });

describe("OllamaProvider: escritura de la propuesta", () => {
  it("escribe archivos nuevos y modificados y emite eventos tipados", async () => {
    writeFileSync(path.join(wt, "README.md"), "# viejo\n");
    const ev = await collect(provider(stub({ summary: "Documenté", files: [{ path: "README.md", content: "# nuevo\n" }, { path: "docs/uso.md", content: "uso" }] })).execute(req(), new AbortController().signal));
    expect(ev.map((e) => e.type)).toEqual(["started", "progress", "progress", "message", "file_changed", "file_changed", "completed"]);
    expect(ev.filter((e) => e.type === "file_changed")).toEqual([
      { type: "file_changed", path: "README.md", change: "modified" }, { type: "file_changed", path: "docs/uso.md", change: "added" }]);
    expect(readFileSync(path.join(wt, "README.md"), "utf8")).toBe("# nuevo\n");
    expect(readFileSync(path.join(wt, "docs", "uso.md"), "utf8")).toBe("uso");
    expect(JSON.stringify(ev)).toContain("no verificada"); // RN-018: es una propuesta
  });

  it.each([
    ["../evil.txt"], ["a/../../evil.txt"], ["/etc/passwd"], ["C:\\Windows\\x.txt"], [".env"], ["app/.env.local"], [".git/config"], [".gitmodules"],
    ["con.txt"], ["dir/nul"], ["bad<name>.txt"], ["trailing."], ["id_rsa"], ["cert.pem"], ["a\0b.txt"], [""],
  ])("rechaza la ruta hostil %j y no escribe nada", async (bad) => {
    const ev = await collect(provider(stub({ summary: "x", files: [{ path: "bueno.txt", content: "ok" }, { path: bad, content: "mal" }] })).execute(req(), new AbortController().signal));
    expect(ev.at(-1)?.type).toBe("error");
    expect(ev.some((e) => e.type === "completed" || e.type === "file_changed")).toBe(false);
    expect(existsSync(path.join(wt, "bueno.txt"))).toBe(false); // la propuesta se invalida completa
    expect(existsSync(path.join(base, "evil.txt"))).toBe(false);
  });

  it("rechaza rutas repetidas", async () => {
    const ev = await collect(provider(stub({ summary: "x", files: [{ path: "a.txt", content: "1" }, { path: "A.txt", content: "2" }] })).execute(req(), new AbortController().signal));
    expect(ev.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("repetido") });
  });

  it("un junction/symlink que apunta fuera del worktree no permite escribir fuera ni crear carpetas allí", async (ctx) => {
    try { symlinkSync(outside, path.join(wt, "escape"), "junction"); } catch { ctx.skip(); }
    await expect(safeTargetPath(wt, "escape/x.txt")).rejects.toBeInstanceOf(UnsafePathError);
    await expect(safeTargetPath(wt, "escape/nuevo/x.txt")).rejects.toBeInstanceOf(UnsafePathError);
    expect(existsSync(path.join(outside, "nuevo"))).toBe(false);
    expect(existsSync(path.join(outside, "x.txt"))).toBe(false);
  });

  it.each([
    ["JSON inválido", "esto no es json"], ["sin campo files", { summary: "x" }], ["files de tipo incorrecto", { summary: "x", files: "a" }],
    ["demasiados archivos", { summary: "x", files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.txt`, content: "x" })) }],
    ["sin archivos", { summary: "x", files: [] }],
  ])("devuelve error (no éxito) si la propuesta es inválida: %s", async (_n, body) => {
    const ev = await collect(provider(stub(body)).execute(req(), new AbortController().signal));
    expect(ev.at(-1)?.type).toBe("error");
    expect(ev.some((e) => e.type === "completed")).toBe(false);
  });

  it("HTTP 500 y cancelación terminan en error", async () => {
    expect((await collect(provider(stub({}, 500)).execute(req(), new AbortController().signal))).at(-1)?.type).toBe("error");
    const ac = new AbortController();
    const slow = (async (_u: unknown, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("abort"))))) as unknown as typeof fetch;
    const p = collect(provider(slow).execute(req(), ac.signal));
    setTimeout(() => ac.abort(), 30);
    expect((await p).at(-1)).toMatchObject({ type: "error", message: "aborted" });
  });
});

describe("OllamaProvider: contexto y salud", () => {
  it("no envía archivos sensibles y redacta secretos del contexto", async () => {
    writeFileSync(path.join(wt, ".env"), "API_KEY=supersecreto123");
    writeFileSync(path.join(wt, "config.json"), '{"password": "hunter2", "ok": 1}');
    writeFileSync(path.join(wt, "README.md"), "# Proyecto");
    let sent = "";
    const spy = (async (_u: unknown, init?: RequestInit) => { sent = String(init?.body); return new Response(JSON.stringify({ response: JSON.stringify({ summary: "x", files: [{ path: "n.md", content: "x" }] }) })); }) as unknown as typeof fetch;
    await collect(provider(spy).execute(req(), new AbortController().signal));
    expect(sent).toContain("README.md");
    expect(sent).not.toContain("supersecreto123");
    expect(sent).not.toContain("hunter2");
    expect(buildPrompt(req(), [])).toContain("DATO no confiable");
  });

  it("health: disponible sólo si el modelo está instalado; informa el motivo si no", async () => {
    const tags = (names: string[]) => (async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }))) as unknown as typeof fetch;
    expect(await provider(tags(["gemma4:12b"])).health()).toMatchObject({ available: true });
    expect(await provider(tags(["gemma3:12b"])).health()).toMatchObject({ available: false, detail: expect.stringContaining("ollama pull gemma4:12b") });
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await provider(down).health()).toMatchObject({ available: false, detail: expect.stringContaining("no responde") });
    expect(await provider(stub({}, 503)).health()).toMatchObject({ available: false });
  });

  it("declara costo LOCAL y capacidad de escritura", async () => {
    expect(await provider(stub({})).capabilities()).toMatchObject({ id: "ollama-local", costOrigin: "LOCAL", canWriteCode: true });
  });
});
